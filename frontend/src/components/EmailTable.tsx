import { useEffect, useState } from "react";
import { api, type Email } from "../services/api";
const formatTime = (s: string) =>
  new Date(s).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    year: "numeric",
  });
export function EmailTable({
  tab,
  refresh,
}: {
  tab: "scheduled" | "sent";
  refresh: number;
}) {
  const [q, setQ] = useState(""),
    [page, setPage] = useState(1),
    [rows, setRows] = useState<Email[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setLoading(true);
    setError("");
    async function load() {
      try {
        const pageOfEmails = await api<{ rows: Email[] }>(
          "/api/emails?" + new URLSearchParams({ tab, q, page: String(page) }),
          { signal: controller.signal },
        );
        if (active) {
          setRows(pageOfEmails.rows);
          setError("");
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        if (active) {
          setLoading(false);
          timer = setTimeout(load, 5000);
        }
      }
    }
    timer = setTimeout(load, q ? 200 : 0);
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [tab, q, page, refresh, retry]);
  const scheduled = tab === "scheduled";
  return (
    <section className="panel">
      <div className="panel-head">
        <h1 className="sr-only">
          {scheduled ? "Scheduled emails" : "Sent emails"}
        </h1>
        <input
          className="search"
          aria-label="Search emails"
          placeholder="Search"
          type="search"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
        />
        <button
          className="refresh"
          aria-label="Refresh emails"
          onClick={() => setRetry((x) => x + 1)}
        >
          ↻
        </button>
      </div>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Recipient</th>
              <th>Subject</th>
              <th>{scheduled ? "Scheduled time" : "Finished time"}</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {!error &&
              !loading &&
              rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <span className="to">To</span> {r.recipient}
                  </td>
                  <td>
                    {r.preview ? (
                      <a href={r.preview} target="_blank" rel="noreferrer">
                        {r.subject}
                      </a>
                    ) : (
                      r.subject
                    )}
                  </td>
                  <td>
                    {formatTime((scheduled ? r.due : r.finished) || r.due)}
                  </td>
                  <td>
                    <span className={"badge " + r.status}>{r.status}</span>
                    {r.detail && <small>{r.detail}</small>}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {loading ? (
        <div className="empty" role="status">
          Loading emails…
        </div>
      ) : error ? (
        <div className="empty" role="alert">
          {error} <button onClick={() => setRetry((x) => x + 1)}>Retry</button>
        </div>
      ) : !rows.length ? (
        <div className="empty">
          <span aria-hidden="true">✉</span>
          <h3>
            {q
              ? "No matching emails"
              : page > 1
                ? "No more emails"
                : scheduled
                  ? "No scheduled emails yet"
                  : "No sent emails yet"}
          </h3>
          <p>
            {q
              ? "Try another recipient or subject."
              : page > 1
                ? "Return to the previous page."
                : scheduled
                  ? "Compose an email to schedule your first delivery."
                  : "Completed delivery attempts will appear here."}
          </p>
        </div>
      ) : null}
      <footer>
        <button disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
          Previous
        </button>
        <span>Page {page}</span>
        <button
          disabled={loading || rows.length < 25 || page >= 400}
          onClick={() => setPage((p) => p + 1)}
        >
          Next
        </button>
      </footer>
    </section>
  );
}
