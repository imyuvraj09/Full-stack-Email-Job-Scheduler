import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Compose } from "./components/Compose";
import { api, type Me } from "./api";
import "./style.css";
import { EmailTable } from "./components/EmailTable";
import { Brand } from "./components/Brand";
function App() {
  const [me, setMe] = useState<Me | null>(),
    [err, setErr] = useState(""),
    [tab, setTab] = useState<"scheduled" | "sent">("scheduled"),
    [compose, setCompose] = useState(false),
    [notice, setNotice] = useState(""),
    [refresh, setRefresh] = useState(0);
  const load = useCallback(() => {
    setErr("");
    api<Me>("/api/me")
      .then(setMe)
      .catch((e) => {
        if (e.message === "Sign in required") setMe(null);
        else setErr(e.message);
      });
  }, []);
  useEffect(load, [load]);
  if (me === undefined)
    return (
      <main className="login">
        <Brand />
        {err ? (
          <p>
            {err} <button onClick={load}>Retry</button>
          </p>
        ) : (
          <p>Loading workspace…</p>
        )}
      </main>
    );
  if (!me)
    return (
      <main className="login">
        <div className="login-card">
          <Brand />
          <h1>Login</h1>
          <a className="primary" href="/auth/google">
            <span className="google-mark" aria-hidden="true">
              G
            </span>{" "}
            Login with Google
          </a>
          {location.search.includes("cancelled") && (
            <p>Sign-in was cancelled.</p>
          )}
        </div>
      </main>
    );
  if (compose)
    return (
      <main className="compose-page">
        {" "}
        <Compose
          me={me}
          close={() => setCompose(false)}
          done={(n) => {
            setNotice(n + " email" + (n === 1 ? "" : "s") + " scheduled.");
            setCompose(false);
            setTab("scheduled");
            setRefresh((x) => x + 1);
          }}
        />
      </main>
    );
  return (
    <div className="layout">
      <aside>
        <header>
          <Brand />{" "}
          <div className="profile">
            {me.user.avatar ? (
              <img alt="" src={me.user.avatar} />
            ) : (
              <span className="avatar">
                {me.user.name.charAt(0).toUpperCase()}
              </span>
            )}
            <div>
              <strong>{me.user.name}</strong>
              <small>{me.user.email}</small>
            </div>
            <button
              onClick={async () => {
                try {
                  await api("/auth/logout", { method: "POST" });
                  setMe(null);
                } catch (e) {
                  setErr((e as Error).message);
                }
              }}
            >
              Log out
            </button>
          </div>
        </header>
        <button
          className="primary"
          onClick={() => {
            setNotice("");
            setCompose(true);
          }}
        >
          Compose new email
        </button>
        <div className="workspace">Core</div>
        <nav aria-label="Email folders">
          {(["scheduled", "sent"] as const).map((t) => (
            <button
              className={!compose && t === tab ? "selected" : ""}
              key={t}
              onClick={() => {
                setTab(t);
                setCompose(false);
              }}
            >
              {t === "scheduled" ? "◷  Scheduled emails" : "↗  Sent emails"}
            </button>
          ))}
        </nav>
        <div className="integrations">
          <div className="workspace">Integrations</div>
          {me.user.connected ? (
            <button
              onClick={async () => {
                try {
                  await api("/auth/slack", { method: "DELETE" });
                  load();
                } catch (e) {
                  setErr((e as Error).message);
                }
              }}
            >
              Disconnect Slack
            </button>
          ) : (
            <a href="/auth/slack">Connect Slack ↗</a>
          )}
          {me.admin && <a href="/ops/queues">Live queue dashboard ↗</a>}
        </div>
      </aside>
      <main>
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        {err && (
          <p className="error" role="alert">
            {err}
          </p>
        )}
        <EmailTable key={tab} tab={tab} refresh={refresh} />
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
