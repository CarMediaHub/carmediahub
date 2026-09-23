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
