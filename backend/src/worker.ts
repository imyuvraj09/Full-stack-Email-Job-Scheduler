import { Worker, DelayedError, type Job } from "bullmq";
import nodemailer from "nodemailer";
import type { PoolClient } from "pg";
import {
  db,
  connection,
  concurrency,
  senders,
  gap,
  cap,
  migrate,
  queue,
} from "./core";
import { allocation, type Bucket } from "./policy";
import { relay } from "./relay";
const transports = new Map(
  senders.map((s) => [
    s.id,
    nodemailer.createTransport({
      host: "smtp.ethereal.email",
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: s.user, pass: s.pass },
      connectionTimeout: 12000,
      greetingTimeout: 12000,
      socketTimeout: 30000,
    }),
  ]),
);
async function postpone(job: Job, at: number, token?: string) {
  await job.moveToDelayed(at, token);
  throw new DelayedError();
}
async function index(c: PoolClient, id: string) {
  await c.query("INSERT INTO event(kind,entity) VALUES('index',$1)", [id]);
}
async function deliver(job: Job, token?: string) {
  const id = job.data.id;
  const c = await db.connect();
  let locked = false;
  let sender = "";
  try {
    const row = (
      await c.query(
        "SELECT e.*,c.sender,c.gap,c.cap,c.owner,c.subject,c.body FROM email e JOIN campaign c ON c.id=e.campaign WHERE e.id=$1",
        [id],
      )
    ).rows[0];
    if (!row || !["sending", "scheduled"].includes(row.status)) return;
    sender = row.sender;
    locked = (
      await c.query("SELECT pg_try_advisory_lock(hashtextextended($1,1)) ok", [
        sender,
      ])
    ).rows[0].ok;
    if (!locked)
      return await postpone(
        job,
        Date.now() + 500 + Math.floor(Math.random() * 500),
        token,
      );
    await c.query("BEGIN");
    const current = (
      await c.query("SELECT status,due FROM email WHERE id=$1 FOR UPDATE", [id])
    ).rows[0];
    if (current.status === "sending") {
      await c.query(
        "UPDATE email SET status='uncertain',finished=now(),detail='Interrupted during SMTP. Inspect Ethereal before retrying manually.',revision=revision+1 WHERE id=$1",
        [id],
      );
      await index(c, id);
      await c.query("COMMIT");
      return;
    }
    if (current.status !== "scheduled") {
      await c.query("COMMIT");
      return;
    }
    const now = Number(
      (
        await c.query(
          "SELECT floor(extract(epoch FROM clock_timestamp())*1000) ms",
        )
      ).rows[0].ms,
    );
    const rules = [
      { key: "sender/" + sender, limit: cap, delay: gap },
      { key: "campaign/" + row.campaign, limit: row.cap, delay: row.gap },
    ];
    const states = [];
    for (const rule of rules) {
      const old = (
        await c.query<Bucket>(
          "SELECT window_id AS window,used,next_at FROM throttle WHERE key=$1",
          [rule.key],
        )
      ).rows[0];
      states.push({ ...rule, ...allocation(now, old, rule.limit) });
    }
    const at = Math.max(+current.due, ...states.map((s) => s.available));
    if (at > now) {
      if (at > +current.due) {
        await c.query(
          "UPDATE email SET due=to_timestamp($2::double precision/1000),revision=revision+1 WHERE id=$1",
          [id, at],
        );
        await index(c, id);
      }
      await c.query("COMMIT");
      return await postpone(job, at, token);
    }
    for (const s of states)
      await c.query(
        "INSERT INTO throttle(key,window_id,used,next_at) VALUES($1,$2,$3,$4) ON CONFLICT(key) DO UPDATE SET window_id=excluded.window_id,used=excluded.used,next_at=excluded.next_at",
        [s.key, s.window, s.used + 1, now + s.delay],
      );
    const hit = states.find((s) => s.hit);
    if (hit)
      await c.query(
        "INSERT INTO event(kind,entity) SELECT 'notify',($2::jsonb || jsonb_build_object('connectionId',md5(slack)))::text FROM account WHERE id=$1 AND slack IS NOT NULL",
        [
          row.owner,
          JSON.stringify({
            owner: row.owner,
            sender,
            window: hit.window,
            limit: hit.limit,
            scope: hit.key.startsWith("sender/") ? "sender" : "campaign",
          }),
        ],
      );
    await c.query(
      "UPDATE email SET status='sending',started=now(),revision=revision+1 WHERE id=$1",
      [id],
    );
    await index(c, id);
    await c.query("COMMIT");
    let status = "sent",
      detail: string | null = null,
      preview: string | null = null;
    try {
      const from = senders.find((s) => s.id === sender);
      if (!from) throw Error("Sender unavailable");
      const info = await transports.get(sender)!.sendMail({
        from: from.user,
        to: row.recipient,
        subject: row.subject,
        text: row.body,
        messageId: "<" + id + "@reachinbox.invalid>",
      });
      preview = nodemailer.getTestMessageUrl(info) || null;
    } catch (e) {
      const err = e as { responseCode?: number; code?: string };
      status =
        err.responseCode || err.code === "EAUTH" ? "failed" : "uncertain";
      detail =
        status === "failed"
          ? "SMTP rejected this attempt."
          : "SMTP acceptance could not be confirmed.";
    }
    await c.query("BEGIN");
    await c.query(
      "UPDATE email SET status=$2,detail=$3,preview=$4,finished=now(),revision=revision+1 WHERE id=$1",
      [id, status, detail, preview],
    );
    for (const rule of rules) {
      await c.query(
        "UPDATE throttle SET next_at=greatest(next_at,ceil(extract(epoch FROM clock_timestamp())*1000)::bigint+$2::bigint) WHERE key=$1",
        [rule.key, rule.delay],
      );
    }
    await index(c, id);
    await c.query("COMMIT");
  } catch (e) {
    if (!(e instanceof DelayedError)) await c.query("ROLLBACK");
    throw e;
  } finally {
    try {
      if (locked)
        await c.query("SELECT pg_advisory_unlock(hashtextextended($1,1))", [
          sender,
        ]);
      c.release();
    } catch {
      c.release(true);
    }
  }
}
await migrate();
const stop = new AbortController();
const relays = (["enqueue", "index", "notify"] as const).map((kind) =>
  relay(kind, stop.signal),
);
const worker = new Worker("delivery", deliver, {
  connection,
  concurrency,
  settings: {
    backoffStrategy: (attempts) =>
      Math.min(60000, 1000 * 2 ** Math.min(attempts - 1, 6)),
  },
});
worker.on("error", (e) => console.error("Worker:", e.name));
async function close() {
  stop.abort();
  await worker.close();
  await Promise.all(relays);
  await queue.close();
  await db.end();
}
process.once("SIGTERM", close);
process.once("SIGINT", close);
