import express, { type ErrorRequestHandler } from "express";
import cookieParser from "cookie-parser";
import campaigns from "./routes/campaigns";
import emails from "./routes/emails";
import { resolve } from "node:path";
import { z } from "zod";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import auth, { identify, required } from "./routes/auth";
import { cap, gap, senders, isAllowedOrigin } from "./config";
import { migrate } from "./db/database";
import { queue } from "./services/queue";
const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type,Authorization,Idempotency-Key",
    );
  }
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  if (
    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
    origin &&
    !isAllowedOrigin(origin)
  ) {
    res.sendStatus(403);
    return;
  }
  next();
});
app.use(express.json({ limit: "3mb" }), cookieParser(), identify);
app.use("/auth", auth);
app.use("/api", required);
app.get("/api/me", (req, res) =>
  res.json({
    user: req.user,
    senders: senders.map(({ id, user }) => ({ id, address: user })),
    gap,
    cap,
    admin: req.user!.email === process.env.QUEUE_ADMIN_EMAIL,
  }),
);
app.use("/api/campaigns", campaigns);
app.use("/api/emails", emails);
const board = new ExpressAdapter();
board.setBasePath("/ops/queues");
createBullBoard({
  queues: [new BullMQAdapter(queue, { readOnlyMode: true })],
  serverAdapter: board,
});
app.use(
  "/ops/queues",
  required,
  (req, res, next) => {
    if (req.user!.email !== process.env.QUEUE_ADMIN_EMAIL) {
      res.sendStatus(403);
      return;
    }
    next();
  },
  board.getRouter(),
);
app.use(express.static(resolve("frontend/dist")));
app.get("/", (_req, res) => res.sendFile(resolve("frontend/dist/index.html")));
const errors: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof z.ZodError) {
    res.status(400).json({
      error: err.issues
        .map((i) => i.path.join(".") + " " + i.message)
        .slice(0, 3)
        .join(", "),
    });
    return;
  }
  console.error(err.name, err.code || "request failed");
  res
    .status(err.status || 503)
    .json({ error: "Request failed. Please try again." });
};
app.use(errors);
await migrate();
const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`API listening on ${port}`));
