import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from "node:crypto";
import { env } from "./config";
export const hash = (x: string) => createHash("sha256").update(x).digest("hex");
const keyHex = env("APP_KEY");
if (!/^[a-f\d]{64}$/i.test(keyHex))
  throw Error("APP_KEY must contain 64 hex characters");
const key = Buffer.from(keyHex, "hex");
export function seal(value: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  return [
    iv,
    Buffer.concat([cipher.update(value, "utf8"), cipher.final()]),
    cipher.getAuthTag(),
  ]
    .map((b) => b.toString("base64url"))
    .join(".");
}
export function unseal(value: string) {
  const [iv, ciphertext, tag] = value
    .split(".")
    .map((x) => Buffer.from(x, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString();
}
