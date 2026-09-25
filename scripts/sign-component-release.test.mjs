import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { signComponentRelease } from "./sign-component-release.mjs";

function fixture() {
  const keys = crypto.generateKeyPairSync("ed25519");
  const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const keyId = crypto.createHash("sha256").update(publicKey).digest("hex").slice(0, 16);
  return { privateKey, keyId, release: { schemaVersion: 1, keyId, componentId: "ffmpeg", version: "7.0.0", artifactId: "ffmpeg-linux-x64", sha256: "a".repeat(64), platform: "linux-x64", provenance: { sourceUrl: "https://ffmpeg.org/download.html", licenseSpdx: "LGPL-2.1" } } };
}

test("signs an explicit unsigned release and binds it to the Ed25519 key", () => {
  const input = fixture();
  const signed = signComponentRelease({ release: input.release }, input.privateKey);
  assert.equal(signed.release.keyId, input.keyId);
  assert.equal(crypto.verify(null, Buffer.from(JSON.stringify({ artifactId: input.release.artifactId, componentId: input.release.componentId, keyId: input.release.keyId, platform: input.release.platform, provenance: input.release.provenance, schemaVersion: 1, sha256: input.release.sha256, version: input.release.version }), "utf8"), crypto.createPublicKey(input.privateKey), Buffer.from(signed.signature, "base64")), true);
});

test("rejects a mismatched key and never accepts an existing output", () => {
  const first = fixture(); const second = fixture();
  assert.throws(() => signComponentRelease({ release: first.release }, second.privateKey), /does not match/u);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-sign-release-"));
  try {
    const releasePath = path.join(root, "unsigned.json"); const keyPath = path.join(root, "key.pem"); const output = path.join(root, "signed.json");
    fs.writeFileSync(releasePath, JSON.stringify({ release: first.release })); fs.writeFileSync(keyPath, first.privateKey);
    const script = path.join(import.meta.dirname, "sign-component-release.mjs");
    const result = spawnSync(process.execPath, [script, "--release", releasePath, "--private-key", keyPath, "--output", output], { encoding: "utf8", env: {} });
    assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).release.keyId, first.keyId);
    const duplicate = spawnSync(process.execPath, [script, "--release", releasePath, "--private-key", keyPath, "--output", output], { encoding: "utf8", env: {} });
    assert.notEqual(duplicate.status, 0); assert.match(duplicate.stderr, /already exists/u);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
