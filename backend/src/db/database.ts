import { Pool, type PoolClient } from "pg";
import { readFile } from "node:fs/promises";
import { env } from "../config";
export const db = new Pool({
  password: env("POSTGRES_PASSWORD"),
  ssl:
    process.env.PGSSLMODE === "require" || process.env.PGSSL === "true"
      ? true
      : undefined,
  max: 40,
});
export async function tx<T>(operation: (client: PoolClient) => Promise<T>) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const r = await operation(client);
    await client.query("COMMIT");
    return r;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
export async function migrate() {
  await tx(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(908321)");
    await client.query(
      await readFile(new URL("./schema.sql", import.meta.url), "utf8"),
    );
  });
}
export const join = " FROM email e JOIN campaign c ON c.id=e.campaign ";
export const fields =
  "e.id,e.recipient,e.due,e.status,e.finished,e.detail,e.preview,c.subject";
