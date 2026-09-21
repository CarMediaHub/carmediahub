import crypto from "node:crypto";
import { validateManifest, type PluginManifest } from "@carmediahub/sdk";
import { canonicalPluginManifest } from "./plugin-release.js";

export interface SignedPluginPackageRelease {
  keyId: string;
  manifest: PluginManifest;
  artifact: { id: string; digest: string };
  signature: string;
}

const keyIdFor = (key: string) => crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);

export function canonicalPluginPackageRelease(release: Pick<SignedPluginPackageRelease, "keyId" | "manifest" | "artifact">): Buffer {
  return Buffer.concat([canonicalPluginManifest(release.manifest), Buffer.from(`\n${release.keyId}\n${release.artifact.id}\n${release.artifact.digest}`, "utf8")]);
}

/** A package signature binds the exact staged directory digest to its manifest. */
export function verifyPluginPackageRelease(release: SignedPluginPackageRelease, trustedPublicKeys: readonly string[]): SignedPluginPackageRelease {
  validateManifest(release.manifest);
  if (!/^[a-f0-9]{16}$/u.test(release.keyId) || !/^[a-z][a-z0-9-]{1,63}$/u.test(release.artifact?.id ?? "") || !/^[a-f0-9]{64}$/u.test(release.artifact?.digest ?? "") || !/^[A-Za-z0-9+/]+={0,2}$/u.test(release.signature)) throw new Error("Invalid signed plugin package release");
  const key = trustedPublicKeys.find((candidate) => keyIdFor(candidate) === release.keyId);
  if (key === undefined || !crypto.verify(null, canonicalPluginPackageRelease(release), key, Buffer.from(release.signature, "base64"))) throw new Error("Plugin package release signature is invalid");
  return release;
}
