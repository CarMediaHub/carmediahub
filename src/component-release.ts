import crypto from "node:crypto";
import { installStagedComponent, type InstalledComponent } from "./component-installer.js";
import { currentPlatformKey, type ComponentCatalogItem } from "./components.js";

const fingerprint = (key: string) => crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
const base64 = /^[A-Za-z0-9+/]+={0,2}$/u;
const identifier = /^[a-z][a-z0-9-]{1,63}$/u;
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const releasePlatform = /^(?:windows|linux|darwin)-(?:x64|arm64)$/u;
const digest = /^[a-f0-9]{64}$/u;

export interface ComponentRelease {
  schemaVersion: 1;
  keyId: string;
  componentId: string;
  version: string;
  artifactId: string;
  sha256: string;
  platform: string;
  provenance?: ComponentProvenance;
}

export interface ComponentProvenance {
  sourceUrl: string;
  licenseSpdx: string;
  sbomSha256?: string;
  releasedAt?: string;
}

export interface SignedComponentRelease {
  release: ComponentRelease;
  signature: string;
}

function canonicalRelease(release: ComponentRelease): Buffer {
  return Buffer.from(JSON.stringify({
    artifactId: release.artifactId, componentId: release.componentId, keyId: release.keyId,
    platform: release.platform, provenance: release.provenance, schemaVersion: release.schemaVersion,
    sha256: release.sha256, version: release.version
  }), "utf8");
}

function validateProvenance(provenance: ComponentProvenance | undefined): void {
  if (provenance === undefined) return;
  if (typeof provenance !== "object" || provenance === null || typeof provenance.sourceUrl !== "string" || !/^https:\/\//u.test(provenance.sourceUrl) || provenance.sourceUrl.length > 2048) throw new Error("Invalid component source URL");
  if (typeof provenance.licenseSpdx !== "string" || !/^[A-Za-z0-9.-]+$/u.test(provenance.licenseSpdx) || provenance.licenseSpdx.length > 128) throw new Error("Invalid component SPDX license");
  if (provenance.sbomSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(provenance.sbomSha256)) throw new Error("Invalid component SBOM digest");
  if (provenance.releasedAt !== undefined && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(provenance.releasedAt)) throw new Error("Invalid component release timestamp");
}

/** Verify an explicit release record against an operator-owned Ed25519 trust set. */
export function verifyComponentRelease(signed: SignedComponentRelease, trustedPublicKeys: readonly string[]): ComponentRelease {
  if (signed.release.schemaVersion !== 1 || !/^[a-f0-9]{16}$/u.test(signed.release.keyId) || !base64.test(signed.signature)
    || !identifier.test(signed.release.componentId) || !identifier.test(signed.release.artifactId)
    || !semver.test(signed.release.version) || !releasePlatform.test(signed.release.platform) || !digest.test(signed.release.sha256)) throw new Error("Invalid signed component release");
  validateProvenance(signed.release.provenance);
  const key = trustedPublicKeys.find((candidate) => fingerprint(candidate) === signed.release.keyId);
  if (key === undefined) throw new Error("Component release signer is not trusted");
  const signature = Buffer.from(signed.signature, "base64");
  if (!crypto.verify(null, canonicalRelease(signed.release), key, signature)) throw new Error("Component release signature is invalid");
  return signed.release;
}

export function installSignedComponentRelease(dataDir: string, catalog: readonly ComponentCatalogItem[], signed: SignedComponentRelease, trustedPublicKeys: readonly string[], platform: string): InstalledComponent {
  const release = verifyComponentRelease(signed, trustedPublicKeys);
  if (release.platform !== platform) throw new Error("Component release platform does not match this deployment");
  if (platform !== currentPlatformKey()) throw new Error("Component release platform does not match the current host");
  const component = catalog.find((item) => item.id === release.componentId);
  if (component === undefined || !component.platforms.includes(release.platform)) throw new Error("Component release platform is not supported by the catalog");
  return installStagedComponent(dataDir, catalog, release);
}
