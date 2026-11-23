import { esHeaders, esBaseUrl } from "../core";

let indexed = false;
export async function ensureEmailIndex() {
  if (indexed) return;
  const path = esBaseUrl() + "/emails";
  const r = await fetch(path, {
    method: "PUT",
    headers: esHeaders("application/json"),
    body: JSON.stringify({
      mappings: {
        properties: {
          id: { type: "keyword" },
          owner: { type: "keyword" },
          status: { type: "keyword" },
          due: { type: "date" },
          finished: { type: "date" },
          recipient: { type: "text" },
          subject: { type: "text" },
          body: { type: "text" },
        },
      },
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (
    !r.ok &&
    (await r.json()).error?.type !== "resource_already_exists_exception"
  )
    throw Error("Index unavailable");
  indexed = true;
}

interface IndexRow {
  id: string;
  revision: string;
  recipient: string;
  status: string;
  due: Date;
  finished: Date | null;
  subject: string;
  body: string;
  owner: string;
}
export async function indexEmails(rows: IndexRow[]) {
  await ensureEmailIndex();
  const lines = rows.flatMap(({ id, revision, ...doc }) => [
    JSON.stringify({
      index: {
        _index: "emails",
        _id: id,
        version: Number(revision),
        version_type: "external_gte",
      },
    }),
    JSON.stringify({ id, ...doc }),
  ]);
  const r = await fetch(esBaseUrl() + "/_bulk", {
    method: "POST",
    headers: esHeaders("application/x-ndjson"),
    body: lines.join("\n") + "\n",
    signal: AbortSignal.timeout(10000),
  });
  if (
    !r.ok ||
    (await r.json()).items.some(
      (x: { index: { status: number } }) =>
        x.index.status >= 300 && x.index.status !== 409,
    )
  ) {
    indexed = false;
    throw Error("Bulk index failed");
  }
}
