import { Pool, type PoolClient } from "pg";
import { Queue } from "bullmq";
import dns from "node:dns";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

try {
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
} catch {}

const origLookup = dns.lookup;
dns.lookup = ((hostname: string, options: any, callback: any) => {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  dns.resolve4(hostname, (err, addresses) => {
    if (!err && addresses && addresses.length > 0) {
      if (options && options.all) {
        return callback(
          null,
          addresses.map((a) => ({ address: a, family: 4 })),
        );
      }
      return callback(null, addresses[0], 4);
    }
    return origLookup(hostname, options, callback);
  });
}) as any;
export function env(k: string) {
  const v = process.env[k];
  if (!v) throw Error("Missing " + k);
  return v;
}
export const base = new URL(env("APP_URL")).origin;
export const db = new Pool({
  password: env("POSTGRES_PASSWORD"),
  ssl:
    process.env.PGSSLMODE === "require" || process.env.PGSSL === "true"
      ? true
      : undefined,
  max: 40,
});
export const connection = {
  host: process.env.REDIS_HOST || "localhost",
  port: process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : 6379,
  username: process.env.REDIS_USER || undefined,
  password: process.env.REDIS_PASSWORD || undefined,
  tls:
    process.env.REDIS_TLS === "true" || process.env.REDIS_PORT === "6380"
      ? {}
      : undefined,
};
export const queue = new Queue("delivery", { connection });
export const senders = z
  .array(
    z.object({
      id: z.string().regex(/^[\w-]+$/),
      user: z.string().email(),
      pass: z.string().min(1),
    }),
  )
  .min(1)
  .parse(JSON.parse(env("SMTP_SENDERS")));
if (
  new Set(senders.map((s) => s.id)).size !== senders.length ||
  new Set(senders.map((s) => s.user.toLowerCase())).size !== senders.length
)
  throw Error("Sender IDs and mailboxes must be unique");
const integer = z.coerce.number().int().positive();
export const gap = integer.max(3600000).parse(process.env.MIN_DELAY_MS || 2000),
  cap = integer.max(1000000).parse(process.env.MAX_EMAILS_PER_HOUR || 200),
  concurrency = integer.max(24).parse(process.env.WORKER_CONCURRENCY || 8);
export const hash = (x: string) => createHash("sha256").update(x).digest("hex");
const key = Buffer.from(env("APP_KEY"), "hex");
if (key.length !== 32) throw Error("APP_KEY must contain 64 hex characters");
export function seal(value: string) {
  const iv = randomBytes(12),
    c = createCipheriv("aes-256-gcm", key, iv);
  return [
    iv,
    Buffer.concat([c.update(value, "utf8"), c.final()]),
    c.getAuthTag(),
  ]
    .map((b) => b.toString("base64url"))
    .join(".");
}
export function unseal(value: string) {
  const [iv, data, tag] = value
    .split(".")
    .map((x) => Buffer.from(x, "base64url"));
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString();
}
export async function tx<T>(fn: (c: PoolClient) => Promise<T>) {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
export async function migrate() {
  await tx(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(908321)");
    await c.query(
      await readFile(new URL("./schema.sql", import.meta.url), "utf8"),
    );
  });
}
export function esHeaders(contentType = "application/json") {
  const headers: Record<string, string> = { "Content-Type": contentType };
  if (process.env.ES_AUTH) {
    headers["Authorization"] =
      process.env.ES_AUTH.startsWith("Bearer ") ||
      process.env.ES_AUTH.startsWith("ApiKey ") ||
      process.env.ES_AUTH.startsWith("Basic ")
        ? process.env.ES_AUTH
        : `Basic ${Buffer.from(process.env.ES_AUTH).toString("base64")}`;
  } else if (process.env.ES_API_KEY) {
    headers["Authorization"] = `ApiKey ${process.env.ES_API_KEY}`;
  } else if (process.env.ES_USERNAME && process.env.ES_PASSWORD) {
    headers["Authorization"] = `Basic ${Buffer.from(`${process.env.ES_USERNAME}:${process.env.ES_PASSWORD}`).toString("base64")}`;
  } else if (process.env.ES_URL) {
    try {
      const u = new URL(process.env.ES_URL);
      if (u.username || u.password) {
        headers["Authorization"] = `Basic ${Buffer.from(`${u.username}:${u.password}`).toString("base64")}`;
      }
    } catch {}
  }
  return headers;
}

export function esBaseUrl() {
  const raw = (process.env.ES_URL || "http://localhost:9200").replace(/\/+$/, "");
  return raw.replace(/\/\/[^@]+@/, "//");
}

export async function elastic(path: string, method = "GET", body?: unknown) {
  const r = await fetch(esBaseUrl() + path, {
    method,
    headers: esHeaders("application/json"),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw Error("Search service " + r.status);
  return r.json();
}
export const join = " FROM email e JOIN campaign c ON c.id=e.campaign ";
export const fields =
  "e.id,e.recipient,e.due,e.status,e.finished,e.detail,e.preview,c.subject";
