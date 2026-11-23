import { z } from "zod";
export function env(name: string) {
  const value = process.env[name];
  if (!value) throw Error("Missing " + name);
  return value;
}
export const base = new URL(
  process.env.APP_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    "http://localhost:3000",
).origin;
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
