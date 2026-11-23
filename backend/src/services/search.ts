function esHeaders(contentType = "application/json") {
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
    headers["Authorization"] =
      `Basic ${Buffer.from(`${process.env.ES_USERNAME}:${process.env.ES_PASSWORD}`).toString("base64")}`;
  } else if (process.env.ES_URL) {
    try {
      const u = new URL(process.env.ES_URL);
      if (u.username || u.password) {
        headers["Authorization"] =
          `Basic ${Buffer.from(`${u.username}:${u.password}`).toString("base64")}`;
      }
    } catch {}
  }
  return headers;
}

function esBaseUrl() {
  const raw = (process.env.ES_URL || "http://localhost:9200").replace(
    /\/+$/,
    "",
  );
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
