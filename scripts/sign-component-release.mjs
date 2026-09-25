import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const identifier = /^[a-z][a-z0-9-]{1,63}$/u;
const version = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const platform = /^(?:windows|linux|darwin)-(?:x64|arm64)$/u;
const digest = /^[a-f0-9]{64}$/u;
const keyIdPattern = /^[a-f0-9]{16}$/u;
const base64 = /^[A-Za-z0-9+/]+={0,2}$/u;

function fail(message) { throw new Error(`Component release signing failed: ${message}`); }
function required(input, key) {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) fail(`${key} is required`);
  return value;
}

function canonicalRelease(release) {
  return Buffer.from(JSON.stringify({
    artifactId: release.artifactId, componentId: release.componentId, keyId: release.keyId,
    platform: release.platform, provenance: release.provenance, schemaVersion: release.schemaVersion,
    sha256: release.sha256, version: release.version
  }), "utf8");
}

function validateRelease(release) {
  if (release === null || typeof release !== "object" || Array.isArray(release) || release.schemaVersion !== 1
    || !keyIdPattern.test(release.keyId ?? "") || !identifier.test(release.componentId ?? "") || !identifier.test(release.artifactId ?? "")
    || !version.test(release.version ?? "") || !platform.test(release.platform ?? "") || !digest.test(release.sha256 ?? "")) fail("release record is invalid");
  if (release.provenance !== undefined && (typeof release.provenance !== "object" || !/^https:\/\//u.test(release.provenance.sourceUrl ?? "") || typeof release.provenance.licenseSpdx !== "string")) fail("release provenance is invalid");
}

export function signComponentRelease(unsigned, privateKeyText) {
  if (unsigned === null || typeof unsigned !== "object" || Array.isArray(unsigned) || unsigned.release === undefined || unsigned.signature !== undefined) fail("input must contain an unsigned release object");
  const release = unsigned.release;
  validateRelease(release);
  let privateKey;
  try { privateKey = crypto.createPrivateKey(privateKeyText); } catch { fail("private key is invalid"); }
  if (privateKey.asymmetricKeyType !== "ed25519") fail("private key must be Ed25519");
  const publicKey = crypto.createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
  const fingerprint = crypto.createHash("sha256").update(publicKey).digest("hex").slice(0, 16);
  if (fingerprint !== release.keyId) fail("release keyId does not match the private key");
  const signature = crypto.sign(null, canonicalRelease(release), privateKey).toString("base64");
  if (!base64.test(signature)) fail("generated signature is invalid");
  return { release, signature };
}

function parse(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]; const value = args[index + 1];
    if (!["--release", "--private-key", "--output"].includes(key) || value === undefined || value.startsWith("--")) fail("usage: sign-component-release --release <unsigned.json> --private-key <ed25519.pem> --output <signed.json>");
    values.set(key, value);
  }
  return { release: values.get("--release"), privateKey: values.get("--private-key"), output: values.get("--output") };
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = parse(process.argv.slice(2).filter((value) => value !== "--"));
    const output = required(input, "output");
    const signed = signComponentRelease(JSON.parse(fs.readFileSync(path.resolve(required(input, "release")), "utf8")), fs.readFileSync(path.resolve(required(input, "privateKey")), "utf8"));
    const target = path.resolve(output);
    if (fs.existsSync(target)) fail("output already exists");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(signed, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    process.stdout.write(`${JSON.stringify({ output: target, keyId: signed.release.keyId })}\n`);
  } catch (error) { console.error(error instanceof Error ? error.message : "Component release signing failed"); process.exitCode = 1; }
}
