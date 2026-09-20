import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const keyFile = "session-hmac.key";
const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

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

export function generateTotpSecret(): string {
  const bytes = crypto.randomBytes(20);
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += base32Alphabet[(value >>> bits) & 31];
    }
  }
  if (bits > 0) output += base32Alphabet[(value << (5 - bits)) & 31];
  return output;
}

function decodeBase32(input: string): Buffer {
  const normalized = input.replace(/=+$/u, "").replace(/\s+/gu, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of normalized) {
    const index = base32Alphabet.indexOf(character);
    if (index < 0) throw new Error("Invalid TOTP secret");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
    }
  }
  return Buffer.from(bytes);
}

export function totpCode(secret: string, timestamp = Date.now()): string {
  const counter = Math.floor(timestamp / 1000 / 30);
  const moving = Buffer.alloc(8);
  moving.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", decodeBase32(secret)).update(moving).digest();
  const offset = digest[digest.length - 1]! & 15;
  const binary = ((digest[offset]! & 127) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, "0");
}

export function verifyTotp(secret: string, code: string, timestamp = Date.now()): boolean {
  if (!/^\d{6}$/u.test(code)) return false;
  const expected = totpCode(secret, timestamp);
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(code));
}

export function encryptSecret(secret: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")).join(".");
}

export function decryptSecret(encoded: string, key: Buffer): string {
  const [ivEncoded, tagEncoded, ciphertextEncoded] = encoded.split(".");
  if (ivEncoded === undefined || tagEncoded === undefined || ciphertextEncoded === undefined) throw new Error("Invalid protected secret");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivEncoded, "base64url"));
  decipher.setAuthTag(Buffer.from(tagEncoded, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextEncoded, "base64url")), decipher.final()]).toString("utf8");
}
