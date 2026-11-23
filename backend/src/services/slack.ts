import type { PoolClient } from "pg";
import { unseal } from "../core";
export async function notifySlack(c: PoolClient, event: string) {
  const { owner, sender, window, limit, scope, connectionId } =
    JSON.parse(event);
  const a = (
    await c.query(
      "SELECT slack FROM account WHERE id=$1 AND ($2::text IS NULL OR md5(slack)=$2)",
      [owner, connectionId || null],
    )
  ).rows[0];
  if (a?.slack) {
    const r = await fetch(unseal(a.slack), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `${scope === "campaign" ? "Campaign using sender" : "Sender"} ${sender} reached its hourly limit of ${limit}. Window started ${new Date(window * 3600000).toISOString()}.`,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw Error("Slack HTTP " + r.status);
  }
}
