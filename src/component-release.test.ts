import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installSignedComponentRelease, verifyComponentRelease, type ComponentRelease } from "./component-release.js";
import { currentPlatformKey, loadComponentCatalog } from "./components.js";

function signedRelease(release: ComponentRelease, privateKey: crypto.KeyObject): { release: ComponentRelease; signature: string } {
  const bytes = Buffer.from(JSON.stringify({ artifactId: release.artifactId, componentId: release.componentId, keyId: release.keyId, platform: release.platform, provenance: release.provenance, schemaVersion: release.schemaVersion, sha256: release.sha256, version: release.version }), "utf8");
  return { release, signature: crypto.sign(null, bytes, privateKey).toString("base64") };
}

test("signed component release requires a trusted Ed25519 signer and exact artifact digest", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-release-"));
  try {
    const keys = crypto.generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const keyId = crypto.createHash("sha256").update(publicKey).digest("hex").slice(0, 16);
    const artifact = "verified release";
    const digest = crypto.createHash("sha256").update(artifact).digest("hex");
    fs.mkdirSync(path.join(dataDir, "staging"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "staging", "ffmpeg-release"), artifact);
    const release: ComponentRelease = { schemaVersion: 1, keyId, componentId: "ffmpeg", version: "7.0.0", artifactId: "ffmpeg-release", sha256: digest, platform: currentPlatformKey(), provenance: { sourceUrl: "https://ffmpeg.org", licenseSpdx: "LGPL-2.1-or-later", sbomSha256: "a".repeat(64), releasedAt: "2026-09-23T00:00:00.000Z" } };
    const signed = signedRelease(release, keys.privateKey);
    assert.deepEqual(verifyComponentRelease(signed, [publicKey]), release);
    const catalog = loadComponentCatalog(path.resolve(import.meta.dirname, ".."));
    assert.equal(installSignedComponentRelease(dataDir, catalog, signed, [publicKey], currentPlatformKey()).id, "ffmpeg");
    assert.throws(() => verifyComponentRelease({ ...signed, release: { ...release, version: "7.0.1" } }, [publicKey]));
    assert.throws(() => verifyComponentRelease(signed, []));
    assert.throws(() => verifyComponentRelease({ ...signed, release: { ...release, provenance: { ...release.provenance, sourceUrl: "http://insecure.example" } } }, [publicKey]), /source URL/);
    assert.throws(() => installSignedComponentRelease(dataDir, catalog, signed, [publicKey], "linux-arm64"), /does not match this deployment/);
    const unsupportedCatalog = catalog.map((item) => item.id === "ffmpeg" ? { ...item, platforms: ["linux-arm64"] } : item);
    assert.throws(() => installSignedComponentRelease(dataDir, unsupportedCatalog, signed, [publicKey], currentPlatformKey()), /not supported by the catalog/);
    const foreignPlatform = "darwin-x64";
    const foreign = signedRelease({ ...release, platform: foreignPlatform }, keys.privateKey);
    assert.throws(() => installSignedComponentRelease(dataDir, catalog, foreign, [publicKey], foreignPlatform), /current host/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
