import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { randomBytes } from "node:crypto";
import { base, db, env, hash, seal, unseal } from "./core";
export type Profile = {
  id: string;
  name: string;
  email: string;
  avatar: string;
  connected: boolean;
};
declare global {
  namespace Express {
    interface Request {
      user?: Profile;
    }
  }
}
export const cookies = {
  httpOnly: true,
  secure: base.startsWith("https:"),
  sameSite: "lax" as const,
  path: "/",
};
export async function identify(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  if (req.cookies.sid) {
    req.user = (
      await db.query(
        "SELECT a.id,a.name,a.email,a.avatar,a.slack IS NOT NULL AS connected FROM session s JOIN account a ON a.id=s.owner WHERE s.id=$1 AND expires>now()",
        [hash(req.cookies.sid)],
      )
    ).rows[0];
  }
  next();
}
export function required(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    res.sendStatus(401);
    return;
  }
  next();
}
const auth = Router();
for (const provider of ["google", "slack"] as const) {
  const google = provider === "google",
    prefix = provider.toUpperCase(),
    callback = base + "/auth/" + provider + "/callback";
  auth.get("/" + provider, (req, res) => {
    if (!google && !req.user) {
      res.sendStatus(401);
      return;
    }
    const state = randomBytes(32).toString("hex");
    res.cookie(
      "flow_" + provider,
      seal(
        JSON.stringify({
          state,
          owner: req.user?.id,
          until: Date.now() + 600000,
        }),
      ),
      { ...cookies, maxAge: 600000 },
    );
    const params = new URLSearchParams({
      client_id: env(prefix + "_CLIENT_ID"),
      redirect_uri: callback,
      response_type: "code",
      state,
      scope: google ? "openid email profile" : "incoming-webhook",
    });
    res.redirect(
      (google
        ? "https://accounts.google.com/o/oauth2/v2/auth?"
        : "https://slack.com/oauth/v2/authorize?") + params,
    );
  });
  auth.get("/" + provider + "/callback", async (req, res) => {
    let flow;
    try {
      flow = JSON.parse(unseal(req.cookies["flow_" + provider]));
    } catch {
      res.sendStatus(403);
      return;
    }
    res.clearCookie("flow_" + provider, cookies);
    if (
      flow.state !== req.query.state ||
      flow.until < Date.now() ||
      (!google && (!req.user || req.user.id !== flow.owner))
    ) {
      res.sendStatus(403);
      return;
    }
    if (typeof req.query.code !== "string") {
      res.redirect("/?auth=cancelled");
      return;
    }
    const form = new URLSearchParams({
      client_id: env(prefix + "_CLIENT_ID"),
      client_secret: env(prefix + "_CLIENT_SECRET"),
      redirect_uri: callback,
      grant_type: "authorization_code",
      code: req.query.code,
    });
    const r = await fetch(
      google
        ? "https://oauth2.googleapis.com/token"
        : "https://slack.com/api/oauth.v2.access",
      { method: "POST", body: form, signal: AbortSignal.timeout(10000) },
    );
    const result = await r.json();
    if (!r.ok) {
      res.sendStatus(502);
      return;
    }
    if (google) {
      if (!result.access_token) {
        res.sendStatus(403);
        return;
      }
      const info = await fetch(
        "https://openidconnect.googleapis.com/v1/userinfo",
        {
          headers: { Authorization: "Bearer " + result.access_token },
          signal: AbortSignal.timeout(10000),
        },
      );
      const p = await info.json();
      if (!info.ok || !p.sub || p.email_verified !== true) {
        res.sendStatus(403);
        return;
      }
      await db.query(
        "INSERT INTO account(id,name,email,avatar) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET name=excluded.name,email=excluded.email,avatar=excluded.avatar",
        [p.sub, p.name || p.email, p.email, p.picture],
      );
      const sid = randomBytes(32).toString("hex");
      await db.query(
        "INSERT INTO session VALUES($1,$2,now()+interval '7 days')",
        [hash(sid), p.sub],
      );
      res.cookie("sid", sid, { ...cookies, maxAge: 7 * 86400000 });
    } else {
      const url = result.incoming_webhook?.url;
      if (
        !result.ok ||
        typeof url !== "string" ||
        !url.startsWith("https://hooks.slack.com/services/")
      ) {
        res.sendStatus(502);
        return;
      }
      await db.query("UPDATE account SET slack=$2 WHERE id=$1", [
        req.user!.id,
        seal(url),
      ]);
    }
    res.redirect("/");
  });
}
auth.post("/logout", required, async (req, res) => {
  await db.query("DELETE FROM session WHERE id=$1", [hash(req.cookies.sid)]);
  res.clearCookie("sid", cookies).sendStatus(204);
});
auth.delete("/slack", required, async (req, res) => {
  await db.query("UPDATE account SET slack=NULL WHERE id=$1", [req.user!.id]);
  res.sendStatus(204);
});
export default auth;
