import { Queue } from "bullmq";
export const connection = {
  host: process.env.REDIS_HOST || "localhost",
  port: process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : 6379,
  username: process.env.REDIS_USER || undefined,
  password: process.env.REDIS_PASSWORD || undefined,
  tls:
    process.env.REDIS_TLS === "true" || process.env.REDIS_PORT === "6380"
      ? {}
      : undefined,
};
export const queue = new Queue("delivery", { connection });
