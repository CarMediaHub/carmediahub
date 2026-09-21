import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { canonicalPluginManifest, verifyPluginRelease } from "./plugin-release.js";
import type { PluginManifest } from "@carmediahub/sdk";

const manifest: PluginManifest = { id: "wdr-media", version: "0.1.0", sdk: "^0.1.0", name: { en: "WDR", "zh-CN": "WDR", ko: "WDR" }, description: { en: "Media", "zh-CN": "媒体", ko: "미디어" }, category: "official", runtime: "isolated-worker", capabilities: ["db"], routes: [{ path: "/", methods: ["GET"] }], worker: { entry: "./worker.js", protocol: "0.1" } };

test("plugin release needs a trusted signer and rejects manifest mutation", () => {
  const keyPair = crypto.generateKeyPairSync("ed25519");
  const publicKey = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const keyId = crypto.createHash("sha256").update(publicKey).digest("hex").slice(0, 16);
  const release = { keyId, manifest, signature: crypto.sign(null, canonicalPluginManifest(manifest), keyPair.privateKey).toString("base64") };
  assert.deepEqual(verifyPluginRelease(release, [publicKey]), manifest);
  assert.throws(() => verifyPluginRelease({ ...release, manifest: { ...manifest, version: "0.1.1" } }, [publicKey]));
  assert.throws(() => verifyPluginRelease(release, []));
});
