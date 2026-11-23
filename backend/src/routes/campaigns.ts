import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { senders, gap, cap, tx, hash } from "../core";
const router = Router();
const schema = z.object({
  sender: z.string().refine((s) => senders.some((x) => x.id === s)),
  subject: z
    .string()
    .trim()
    .min(1)
    .max(250)
    .regex(/^[^\r\n]+$/),
  body: z.string().trim().min(1).max(100000),
  start: z.string().datetime(),
  delay: z.number().int().min(gap).max(3600000),
  hourly: z.number().int().min(1).max(cap),
  leads: z
    .array(
      z
        .string()
        .trim()
        .email()
        .max(254)
        .transform((v) => v.toLowerCase()),
    )
    .min(1)
    .max(10000),
});
router.post("/", async (req, res) => {
  const key = z.string().uuid().parse(req.header("Idempotency-Key"));
  const p = schema.parse(req.body),
    leads = [...new Set(p.leads)],
    digest = hash(JSON.stringify({ ...p, leads }));
  const result = await tx(async (c) => {
    const id = randomUUID();
    const insert = await c.query(
      "INSERT INTO campaign(id,owner,request_key,digest,sender,subject,body,gap,cap) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(owner,request_key) DO NOTHING RETURNING id",
      [
        id,
        req.user!.id,
        key,
        digest,
        p.sender,
        p.subject,
        p.body,
        p.delay,
        p.hourly,
      ],
    );
    if (!insert.rowCount) {
      const old = (
        await c.query(
          "SELECT id,digest FROM campaign WHERE owner=$1 AND request_key=$2",
          [req.user!.id, key],
        )
      ).rows[0];
      return { code: old.digest === digest ? 200 : 409, id: old.id };
    }
    await c.query(
      `WITH added AS (INSERT INTO email(id,campaign,recipient,due) SELECT gen_random_uuid(),$1,r,$2::timestamptz+(n-1)*$3::bigint*interval '1 millisecond' FROM unnest($4::text[]) WITH ORDINALITY AS l(r,n) RETURNING id) INSERT INTO event(kind,entity) SELECT k,id::text FROM added CROSS JOIN unnest(ARRAY['enqueue','index']) k`,
      [id, p.start, p.delay, leads],
    );
    return { code: 201, id };
  });
  res
    .status(result.code)
    .json(
      result.code === 409
        ? { error: "This key already belongs to another request." }
        : { id: result.id, count: leads.length },
    );
});
export default router;
