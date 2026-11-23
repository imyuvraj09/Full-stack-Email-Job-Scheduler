import { indexEmails } from "./services/search";
import { notifySlack } from "./services/slack";
import { queue, join, tx } from "./core";
import { setTimeout as pause } from "node:timers/promises";
export async function relay(
  kind: "enqueue" | "index" | "notify",
  signal: AbortSignal,
) {
  while (!signal.aborted) {
    try {
      const count = await tx(async (c) => {
        const events = (
          await c.query(
            "SELECT * FROM event WHERE kind=$1 AND available<=now() ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED",
            [kind, kind === "notify" ? 1 : 100],
          )
        ).rows;
        if (!events.length) return 0;
        const keys = events.map((e) => e.id);
        try {
          if (kind === "notify") {
            await notifySlack(c, events[0].entity);
          } else {
            const rows = (
              await c.query(
                "SELECT e.id,e.recipient,e.status,e.due,e.finished,e.revision,c.subject,c.body,c.owner" +
                  join +
                  "WHERE e.id=ANY($1::uuid[]) ORDER BY e.due,e.id",
                [events.map((e) => e.entity)],
              )
            ).rows;
            if (kind === "enqueue") {
              const jobs = rows
                .filter((r) => r.status === "scheduled")
                .map((r) => ({
                  name: "send",
                  data: { id: r.id },
                  opts: {
                    jobId: r.id,
                    delay: Math.max(0, +r.due - Date.now()),
                    attempts: 100,
                    backoff: { type: "bounded" },
                    removeOnComplete: 10000,
                    removeOnFail: 10000,
                  },
                }));
              if (jobs.length) await queue.addBulk(jobs);
            } else {
              await indexEmails(rows);
            }
          }
          await c.query("DELETE FROM event WHERE id=ANY($1::bigint[])", [keys]);
        } catch (e) {
          console.warn("Retrying", kind, e instanceof Error ? e.name : "error");
          await c.query(
            "UPDATE event SET attempts=attempts+1,available=now()+least(60,1+attempts*2)*interval '1 second' WHERE id=ANY($1::bigint[])",
            [keys],
          );
        }
        return events.length;
      });
      if (!count) await pause(350);
    } catch {
      await pause(1500);
    }
  }
}
