import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const template = await readFile(new URL("../.env.example", import.meta.url), "utf8");
const settings = template
  .replace(/^APP_KEY=$/m, () => "APP_KEY=" + randomBytes(32).toString("hex"))
  .replace(/^POSTGRES_PASSWORD=$/m, () => "POSTGRES_PASSWORD=" + randomBytes(24).toString("hex"));

try {
  await writeFile(new URL("../.env", import.meta.url), settings, { flag: "wx", mode: 0o600 });
  console.log("Created .env. Set your PostgreSQL role password and provider credentials before starting.");
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.log("Your existing .env was kept.");
}
