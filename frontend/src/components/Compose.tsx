import React, { useRef, useState } from "react";
import { api, type Me } from "../api";
import { parseLeads } from "../leads";
export function Compose({
  me,
  close,
  done,
}: {
  me: Me;
  close: () => void;
  done: (n: number) => void;
}) {
  const [leads, setLeads] = useState<string[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false),
    version = useRef(0),
    request = useRef({ key: "", body: "" });
  const now = new Date(),
    initial = new Date(+now - now.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!leads.length) {
      setError("Upload a file containing at least one email address.");
      return;
    }
    const f = new FormData(e.currentTarget);
    const payload = JSON.stringify({
      subject: f.get("subject"),
      body: f.get("body"),
      sender: f.get("sender"),
      start: new Date(String(f.get("start"))).toISOString(),
      delay: Math.round(Number(f.get("delay")) * 1000),
      hourly: Number(f.get("hourly")),
      leads,
    });
    if (request.current.body !== payload)
      request.current = { key: crypto.randomUUID(), body: payload };
    setBusy(true);
    setError("");
    try {
      const r = await api<{ count: number }>("/api/campaigns", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": request.current.key,
        },
        body: payload,
      });
      done(r.count);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel compose">
      <header className="compose-head">
        <div>
          <button aria-label="Back to emails" disabled={busy} onClick={close}>
            ←
          </button>
          <h1>Compose new email</h1>
        </div>
        <button
          className="primary"
          form="compose-email"
          disabled={busy || reading}
        >
          {busy ? "Scheduling…" : "Schedule emails"}
        </button>
      </header>
      <form id="compose-email" onSubmit={submit}>
        <fieldset disabled={busy}>
          <label>
            From
            <select name="sender">
              {me.senders.map((s) => (
                <option value={s.id} key={s.id}>
                  {s.address}
                </option>
              ))}
            </select>
          </label>
          <label className="upload">
            <span>To</span>
            <span className="file-action">↑ Upload list</span>
            <input
              aria-label="Upload recipient list"
              type="file"
              accept=".csv,.txt,text/plain,text/csv"
              onChange={async (e) => {
                const file = e.target.files?.[0],
                  v = ++version.current;
                setLeads([]);
                setError("");
                setReading(true);
                try {
                  if (file && file.size > 3000000)
                    throw Error("Choose a file smaller than 3 MB.");
                  const list = parseLeads(file ? await file.text() : "");
                  if (list.length > 10000)
                    throw Error("Use up to 10,000 addresses per campaign.");
                  if (version.current === v) setLeads(list);
                } catch (err) {
                  if (version.current === v) setError((err as Error).message);
                } finally {
                  if (version.current === v) setReading(false);
                }
              }}
            />
            <small aria-live="polite">
              {reading
                ? "Reading file…"
                : leads.length + " unique email addresses detected"}
            </small>
          </label>
          <label>
            Subject
            <input
              name="subject"
              required
              maxLength={250}
              placeholder="Email subject"
            />
          </label>
          <div className="timing">
            <label>
              Start time · local
              <input
                type="datetime-local"
                name="start"
                required
                defaultValue={initial}
              />
            </label>
            <label>
              Delay (seconds)
              <input
                type="number"
                name="delay"
                min={me.gap / 1000}
                step=".001"
                max={3600}
                defaultValue={me.gap / 1000}
                required
              />
            </label>
            <label>
              Emails per hour
              <input
                type="number"
                name="hourly"
                min={1}
                max={me.cap}
                defaultValue={me.cap}
                required
              />
            </label>
          </div>
          <label className="message">
            Message
            <textarea
              name="body"
              required
              maxLength={100000}
              rows={12}
              placeholder="Write your message…"
            />
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </fieldset>
      </form>
    </section>
  );
}
