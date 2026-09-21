import crypto from "node:crypto";
import { validateManifest } from "@carmediahub/sdk";
import type { PluginManifest } from "@carmediahub/sdk";

export interface SignedPluginRelease {
  keyId: string;
  manifest: PluginManifest;
  signature: string;
}

const keyIdFor = (key: string) => crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

export function canonicalPluginManifest(manifest: PluginManifest): Buffer { return Buffer.from(canonical(manifest), "utf8"); }

/** Only Core validates release signers; plugin code receives no trust material. */
export function verifyPluginRelease(release: SignedPluginRelease, trustedPublicKeys: readonly string[]): PluginManifest {
  validateManifest(release.manifest);
  if (!/^[a-f0-9]{16}$/u.test(release.keyId) || !/^[A-Za-z0-9+/]+={0,2}$/u.test(release.signature)) throw new Error("Invalid signed plugin release");
  const key = trustedPublicKeys.find((candidate) => keyIdFor(candidate) === release.keyId);
  if (key === undefined) throw new Error("Plugin release signer is not trusted");
  if (!crypto.verify(null, canonicalPluginManifest(release.manifest), key, Buffer.from(release.signature, "base64"))) throw new Error("Plugin release signature is invalid");
  return release.manifest;
}
