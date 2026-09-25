import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CredentialVault } from "./credential-vault.js";

test("credential vault returns opaque metadata and resolves only the exact plugin scope", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-credentials-"));
  const vault = new CredentialVault(dataDir, crypto.randomBytes(32));
  const scope = { deploymentId: "d", organizationId: "o", userId: "u", deviceId: "pc", sessionId: "s", installationId: "plugin-a" } as const;
  const credential = vault.create(scope, { name: "BBC session", kind: "cookie", value: "session=private" });
  assert.equal("value" in credential, false);
  assert.deepEqual(vault.resolve(scope, credential.id), { name: "cookie", value: "session=private" });
  assert.equal(vault.resolve({ ...scope, installationId: "plugin-b" }, credential.id), undefined);
  assert.equal(fs.readFileSync(path.join(dataDir, "secrets", "credentials.json"), "utf8").includes("session=private"), false);
  assert.equal(vault.revoke(scope, credential.id), true);
  assert.equal(vault.resolve(scope, credential.id), undefined);
});

test("credential vault hides expired credentials and accepts legacy records without expiry", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-credentials-expiry-"));
  const vault = new CredentialVault(dataDir, crypto.randomBytes(32));
  const scope = { deploymentId: "d", organizationId: "o", userId: "u", deviceId: "pc", sessionId: "s", installationId: "plugin-a" } as const;
  assert.throws(() => vault.create(scope, { name: "expired", kind: "cookie", value: "x", expiresAt: "2000-01-01T00:00:00.000Z" }));
  const credential = vault.create(scope, { name: "future", kind: "cookie", value: "session=x", expiresAt: "2999-01-01T00:00:00.000Z" });
  assert.equal(credential.expiresAt, "2999-01-01T00:00:00.000Z");
  assert.equal(vault.list(scope).length, 1);
  const file = path.join(dataDir, "secrets", "credentials.json");
  const stored = JSON.parse(fs.readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
  stored[0]!.expiresAt = "2000-01-01T00:00:00.000Z";
  fs.writeFileSync(file, JSON.stringify(stored));
  const expiredVault = new CredentialVault(dataDir, (vault as unknown as { key: Buffer }).key);
  assert.equal(expiredVault.list(scope).length, 0);
});

test("credential rotation revokes the old value and preserves the installation scope", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-credentials-rotate-"));
  const vault = new CredentialVault(dataDir, crypto.randomBytes(32));
  const scope = { deploymentId: "d", organizationId: "o", userId: "u", deviceId: "pc", sessionId: "s", installationId: "plugin-a" } as const;
  const original = vault.create(scope, { name: "BBC", kind: "cookie", value: "old" });
  const replacement = vault.rotate(scope, original.id, { value: "new", expiresAt: "2999-01-01T00:00:00.000Z" });
  assert.ok(replacement);
  assert.notEqual(replacement.id, original.id);
  assert.equal(vault.resolve(scope, original.id), undefined);
  assert.deepEqual(vault.resolve(scope, replacement.id), { name: "cookie", value: "new" });
  assert.equal(vault.rotate({ ...scope, installationId: "plugin-b" }, replacement.id, { value: "blocked" }), undefined);
});

test("credential vault rejects malformed persisted scope and timestamps", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-credentials-invalid-"));
  const location = path.join(dataDir, "secrets", "credentials.json");
  fs.mkdirSync(path.dirname(location), { recursive: true });
  fs.writeFileSync(location, JSON.stringify([{ id: "cred_bad", name: "bad", kind: "cookie", organizationId: "org", userId: "user", installationId: "plugin-a", createdAt: "not-a-time", revokedAt: null, value: "encrypted" }]));
  assert.throws(() => new CredentialVault(dataDir, crypto.randomBytes(32)), /invalid/);
});

test("credential revocation keeps memory and disk updates atomic", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-credentials-revoke-"));
  const vault = new CredentialVault(dataDir, crypto.randomBytes(32));
  const scope = { deploymentId: "d", organizationId: "o", userId: "u", deviceId: "pc", sessionId: "s", installationId: "plugin-a" } as const;
  const credential = vault.create(scope, { name: "session", kind: "cookie", value: "secret" });
  const originalPersist = (vault as unknown as { persist: (records?: unknown) => void }).persist;
  (vault as unknown as { persist: (records?: unknown) => void }).persist = () => { throw new Error("disk unavailable"); };
  assert.throws(() => vault.revoke(scope, credential.id), /disk unavailable/);
  assert.deepEqual(vault.resolve(scope, credential.id), { name: "cookie", value: "secret" });
  (vault as unknown as { persist: (records?: unknown) => void }).persist = originalPersist;
  const reopened = new CredentialVault(dataDir, (vault as unknown as { key: Buffer }).key);
  assert.deepEqual(reopened.resolve(scope, credential.id), { name: "cookie", value: "secret" });
});
