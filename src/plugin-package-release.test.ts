import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { canonicalPluginPackageRelease, verifyPluginPackageRelease } from "./plugin-package-release.js";

const manifest = { id: "wdr-media", version: "0.1.0", sdk: "^0.1.0", name: { en: "WDR", "zh-CN": "WDR", ko: "WDR" }, description: { en: "Media", "zh-CN": "媒体", ko: "미디어" }, category: "official", runtime: "isolated-worker", capabilities: ["db"], routes: [{ path: "/", methods: ["GET"] }], worker: { entry: "./worker.js", protocol: "0.1" } } as const;

test("plugin package signature binds its staged artifact digest", () => {
  const pair = crypto.generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const keyId = crypto.createHash("sha256").update(publicKey).digest("hex").slice(0, 16);
  const unsigned = { keyId, manifest, artifact: { id: "wdr-build", digest: "a".repeat(64) } };
  const release = { ...unsigned, signature: crypto.sign(null, canonicalPluginPackageRelease(unsigned), pair.privateKey).toString("base64") };
  assert.equal(verifyPluginPackageRelease(release, [publicKey]).artifact.id, "wdr-build");
  assert.throws(() => verifyPluginPackageRelease({ ...release, artifact: { ...release.artifact, digest: "b".repeat(64) } }, [publicKey]));
});
