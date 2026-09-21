import crypto from "node:crypto";
import { installStagedComponent, type InstalledComponent } from "./component-installer.js";
import type { ComponentCatalogItem } from "./components.js";

const fingerprint = (key: string) => crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
const base64 = /^[A-Za-z0-9+/]+={0,2}$/u;

export interface ComponentRelease {
  schemaVersion: 1;
  keyId: string;
  componentId: string;
  version: string;
  artifactId: string;
  sha256: string;
  platform: string;
}

export interface SignedComponentRelease {
  release: ComponentRelease;
  signature: string;
}

function canonicalRelease(release: ComponentRelease): Buffer {
  return Buffer.from(JSON.stringify({
    artifactId: release.artifactId, componentId: release.componentId, keyId: release.keyId,
    platform: release.platform, schemaVersion: release.schemaVersion, sha256: release.sha256, version: release.version
  }), "utf8");
}

/** Verify an explicit release record against an operator-owned Ed25519 trust set. */
export function verifyComponentRelease(signed: SignedComponentRelease, trustedPublicKeys: readonly string[]): ComponentRelease {
  if (signed.release.schemaVersion !== 1 || !/^[a-f0-9]{16}$/u.test(signed.release.keyId) || !base64.test(signed.signature)) throw new Error("Invalid signed component release");
  const key = trustedPublicKeys.find((candidate) => fingerprint(candidate) === signed.release.keyId);
  if (key === undefined) throw new Error("Component release signer is not trusted");
  const signature = Buffer.from(signed.signature, "base64");
  if (!crypto.verify(null, canonicalRelease(signed.release), key, signature)) throw new Error("Component release signature is invalid");
  return signed.release;
}

export function installSignedComponentRelease(dataDir: string, catalog: readonly ComponentCatalogItem[], signed: SignedComponentRelease, trustedPublicKeys: readonly string[], platform: string): InstalledComponent {
  const release = verifyComponentRelease(signed, trustedPublicKeys);
  if (release.platform !== platform) throw new Error("Component release platform does not match this deployment");
  return installStagedComponent(dataDir, catalog, release);
}
