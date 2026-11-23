import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID, randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { SMTPServer } from "smtp-server";
import { Pool } from "pg";
import { Queue } from "bullmq";

const base = "http://127.0.0.1:3000";
async function eventually(fn, timeout = 40000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      last = e;
    }
    await sleep(150);
  }
  throw last || new Error("Timed out waiting for " + fn);
}
async function oauth(provider, cookie = "", identity = "operator") {
  const first = await fetch(base + "/auth/" + provider, {
    redirect: "manual",
    headers: { cookie },
  });
  assert.equal(first.status, 302);
  const target = new URL(first.headers.get("location"));
  assert.equal(
    target.hostname,
    provider === "google" ? "accounts.google.com" : "slack.com",
  );
  const flow = first.headers.getSetCookie()[0].split(";")[0];
  const callback = new URL(target.searchParams.get("redirect_uri"));
  callback.searchParams.set("code", identity);
  callback.searchParams.set("state", target.searchParams.get("state"));
  const result = await fetch(callback, {
    headers: { cookie: [cookie, flow].filter(Boolean).join("; ") },
    redirect: "manual",
  });
  assert.equal(result.status, 302);
  return (
    result.headers
      .getSetCookie()
      .find((v) => v.startsWith("sid="))
      ?.split(";")[0] || cookie
  );
}

test(
  "Postgres, Redis, BullMQ, Elasticsearch and SMTP integration",
  { timeout: 210000 },
  async (t) => {
    assert.equal(
      process.env.PGDATABASE,
      "reachinbox_integration",
      "Use the isolated integration database",
    );
    const env = {
      ...process.env,
      APP_URL: base,
      PORT: "3000",
      APP_KEY: randomBytes(32).toString("hex"),
      MAX_EMAILS_PER_HOUR: "2",
      MIN_DELAY_MS: "250",
      WORKER_CONCURRENCY: "4",
      QUEUE_ADMIN_EMAIL: "operator@example.org",
      GOOGLE_CLIENT_ID: "fixture",
      GOOGLE_CLIENT_SECRET: "fixture",
      SLACK_CLIENT_ID: "fixture",
      SLACK_CLIENT_SECRET: "fixture",
      SMTP_SENDERS: JSON.stringify(
        ["one", "two", "interrupted"].map((id) => ({
          id,
          user: id + "@ethereal.email",
          pass: "fixture",
        })),
      ),
    };
    const db = new Pool({ password: env.POSTGRES_PASSWORD });
    const connection = { host: env.REDIS_HOST || "127.0.0.1", port: Number(env.REDIS_PORT || 6379) };
    const queue = new Queue("delivery", { connection });
    const processes = new Set();
    const receipts = [],
      messages = [];
    const smtp = new SMTPServer({
      disabledCommands: ["AUTH", "STARTTLS"],
      onData(stream, session, done) {
        stream.resume();
        stream.on("end", () => {
          receipts.push({
            email: session.envelope.rcptTo[0].address,
            at: Date.now(),
          });
          if (session.envelope.rcptTo[0].address === "crash@example.org") {
            // The receiving SMTP server has the bytes. Stop the workers before it acknowledges acceptance.
            for (const worker of workers) worker.kill("SIGKILL");
          }
          done(null, "accepted");
        });
      },
    });
    const provider = createServer(async (req, res) => {
      let body = "";
      for await (const part of req) body += part;
      const user = req.headers.authorization?.replace("Bearer ", "");
      const form = new URLSearchParams(body);
      res.setHeader("content-type", "application/json");
      switch (req.url) {
        case "/token":
          res.end(JSON.stringify({ access_token: form.get("code") }));
          break;
        case "/user":
          res.end(
            JSON.stringify({
              sub: user,
              email: user + "@example.org",
              email_verified: true,
              name: user,
            }),
          );
          break;
        case "/slack":
          res.end(
            JSON.stringify({
              ok: true,
              incoming_webhook: {
                url: "https://hooks.slack.com/services/test/channel",
              },
            }),
          );
          break;
        case "/message":
          messages.push(JSON.parse(body));
          res.end("ok");
          break;
        default:
          res.writeHead(404);
          res.end();
      }
    });
    const start = (entry) => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "./tests/integration/provider-fixture.mjs",
          "--import",
          "tsx",
          "backend/src/" + entry + ".ts",
        ],
        { env, stdio: "inherit" },
      );
      processes.add(child);
      child.once("exit", () => processes.delete(child));
      return child;
    };
    async function stop(child) {
      if (!processes.has(child)) return;
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    t.after(async () => {
      await Promise.all([...processes].map(stop));
      await queue.close();
      await db.end();
      if (provider.listening) await new Promise((r) => provider.close(r));
      await new Promise((r) => smtp.close(r));
    });
    await new Promise((r) => smtp.listen(2525, "127.0.0.1", r));
    await new Promise((r) => provider.listen(3250, "127.0.0.1", r));
    const es = env.ES_URL || "http://localhost:9200";
    await eventually(
      async () => (await fetch(es + "/_cluster/health")).ok,
      60000,
    );
    let api = start("api"),
      workers = [start("worker"), start("worker")];
    await eventually(
      async () => (await fetch(base + "/api/me")).status === 401,
    );
    const owner = await oauth("google"),
      other = await oauth("google", "", "guest");
    const request = (url, cookie = owner, init = {}) =>
      fetch(base + url, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          cookie,
          ...init.headers,
        },
      });
    assert.equal((await request("/ops/queues/", other)).status, 403);
    assert.equal((await request("/ops/queues/")).status, 200);
    assert.equal(
      (await request("/auth/slack/callback?state=incorrect&code=invalid"))
        .status,
      403,
    );
    await oauth("slack", owner);
    assert.equal(
      (await (await request("/api/me")).json()).user.connected,
      true,
    );
    const suffix = randomUUID().slice(0, 8),
      subject = "Research " + suffix;
    const nextHour = (Math.floor(Date.now() / 3600000) + 1) * 3600000;
    const startAt =
      nextHour - Date.now() < 35000 ? nextHour + 1000 : Date.now() + 9000;
    const campaign = {
      subject,
      body: "Integration test message.",
      leads: ["a@example.org", "b@example.org", "c@example.org"],
      sender: "one",
      delay: 250,
      hourly: 2,
      start: new Date(startAt).toISOString(),
    };
    const submit = (data, key = randomUUID()) =>
      request("/api/campaigns", owner, {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body: JSON.stringify(data),
      });
    const key = randomUUID();
    const replay = await Promise.all([
      submit(campaign, key),
      submit(campaign, key),
    ]);
    assert.deepEqual(replay.map((r) => r.status).sort(), [200, 201]);
    const replies = await Promise.all(replay.map((r) => r.json()));
    assert.equal(replies[0].id, replies[1].id);
    assert.equal(
      (await submit({ ...campaign, subject: "Different" }, key)).status,
      409,
    );
    async function rows(tab, q, cookie = owner) {
      const r = await request(
        "/api/emails?" + new URLSearchParams({ tab, q }),
        cookie,
      );
      assert.equal(r.status, 200);
      return (await r.json()).rows;
    }
    await eventually(
      async () => (await rows("scheduled", suffix)).length === 3,
    );
    assert.equal((await rows("scheduled", suffix, other)).length, 0);
    const initial = await rows("scheduled", suffix);
    await eventually(async () => (await queue.getDelayedCount()) >= 3);
    await Promise.all([stop(api), ...workers.map(stop)]);
    assert.equal(receipts.length, 0, "restart must precede the first delivery");
    api = start("api");
    workers = [start("worker"), start("worker")];
    await eventually(
      async () =>
        (await rows("sent", suffix)).filter((r) => r.status === "sent")
          .length === 2,
      55000,
    );
    await eventually(() => messages.length === 1);
    assert.match(messages[0].text, /one.*limit of 2/);
    const deferred = await eventually(async () =>
      (await rows("scheduled", suffix)).find(
        (r) =>
          Date.parse(r.due) > Date.now() + 1000 &&
          new Date(r.due).getUTCMinutes() === 0,
      ),
    );
    assert.equal(new Date(deferred.due).getUTCMinutes(), 0);
    assert.deepEqual(
      new Set([...(await rows("sent", suffix)), deferred].map((r) => r.id)),
      new Set(initial.map((r) => r.id)),
    );
    assert.equal(receipts.length, 2);
    assert.equal(new Set(receipts.map((r) => r.email)).size, 2);
    assert.ok(receipts[1].at - receipts[0].at >= 250);
    assert.equal(
      (await request("/auth/slack", owner, { method: "DELETE" })).status,
      204,
    );
    const second = {
      ...campaign,
      sender: "two",
      start: new Date().toISOString(),
      leads: ["d@example.org"],
      hourly: 1,
    };
    assert.equal((await submit(second)).status, 201);
    await eventually(() => receipts.length === 3);
    assert.equal(messages.length, 1);
    await oauth("slack", owner);
    assert.equal(
      (await submit({ ...second, leads: ["e@example.org"] })).status,
      201,
    );
    await eventually(() => receipts.length === 4 && messages.length === 2);
    assert.match(messages[1].text, /two/);
    // A large campaign is submitted far enough ahead that no bulk SMTP traffic leaves this test.
    const bulk = {
      ...campaign,
      subject: "Bulk " + suffix,
      start: new Date(Date.now() + 7200000).toISOString(),
      leads: Array.from(
        { length: 1000 },
        (_, i) => "lead" + i + "@example.org",
      ),
    };
    const burst = await submit(bulk);
    assert.equal(burst.status, 201);
    const ids = (
      await db.query("SELECT id FROM email WHERE campaign=$1", [
        (await burst.json()).id,
      ])
    ).rows;
    assert.equal(ids.length, 1000);
    await eventually(async () => (await queue.getDelayedCount()) >= 1001);
    assert.equal(receipts.length, 4);
    const crash = {
      ...campaign,
      sender: "interrupted",
      subject: "Interrupted " + suffix,
      leads: ["crash@example.org"],
      start: new Date().toISOString(),
    };
    assert.equal((await submit(crash)).status, 201);
    await eventually(
      () =>
        receipts.some((r) => r.email === "crash@example.org") &&
        workers.every((w) => !processes.has(w)),
    );
    workers = [start("worker"), start("worker")];
    await eventually(
      async () =>
        (await rows("sent", "Interrupted " + suffix)).some(
          (r) => r.status === "uncertain",
        ),
      85000,
    );
    assert.equal(
      receipts.filter((r) => r.email === "crash@example.org").length,
      1,
    );
    assert.equal(
      (await request("/auth/logout", owner, { method: "POST" })).status,
      204,
    );
    assert.equal((await request("/api/me")).status, 401);
  },
);
