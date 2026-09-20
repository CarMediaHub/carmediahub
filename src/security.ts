import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const keyFile = "session-hmac.key";

export function ensureServerKey(dataDir: string): Buffer {
  const secretDir = path.join(dataDir, "secrets");
  const location = path.join(secretDir, keyFile);
  fs.mkdirSync(secretDir, { recursive: true });
  if (!fs.existsSync(location)) {
    fs.writeFileSync(location, crypto.randomBytes(32), { mode: 0o600 });
  }
  return fs.readFileSync(location);
}

export function hashPassword(password: string, salt = crypto.randomBytes(16).toString("base64url")): string {
  if (password.length < 12) throw new Error("Password must have at least 12 characters");
  const derived = crypto.scryptSync(password, salt, 64).toString("base64url");
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const [algorithm, salt, expected] = encoded.split("$");
  if (algorithm !== "scrypt" || salt === undefined || expected === undefined) return false;
  const actual = crypto.scryptSync(password, salt, 64).toString("base64url");
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

export function randomToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function keyedHash(value: string, key: Buffer): string {
  return crypto.createHmac("sha256", key).update(value).digest("base64url");
}
