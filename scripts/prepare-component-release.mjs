import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const identifier = /^[a-z][a-z0-9-]{1,63}$/u;
const version = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const platform = /^(?:windows|linux)-(?:x64|arm64)$/u;

function fail(message) { throw new Error(`Component release preparation failed: ${message}`); }

function required(input, key) {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) fail(`${key} is required`);
  return value;
}

function regularFile(location, label) {
  let stat;
  try { stat = fs.lstatSync(location); } catch { fail(`${label} does not exist`); }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular file`);
}

function digest(location) {
  return crypto.createHash("sha256").update(fs.readFileSync(location)).digest("hex");
}

/** Copy an operator-selected binary into explicit staging and return an unsigned release record. */
export function prepareComponentRelease(input) {
  const dataDir = path.resolve(required(input, "dataDir"));
  const artifact = path.resolve(required(input, "artifact"));
  const componentId = required(input, "componentId");
  const artifactId = required(input, "artifactId");
  const releaseVersion = required(input, "version");
  const releasePlatform = required(input, "platform");
  if (!identifier.test(componentId) || !identifier.test(artifactId)) fail("componentId and artifactId must be lowercase identifiers");
  if (!version.test(releaseVersion)) fail("version must be semantic version 2");
  if (!platform.test(releasePlatform)) fail("platform must be windows-x64, linux-x64, or linux-arm64");
  if (input.sourceUrl !== undefined && (typeof input.sourceUrl !== "string" || !/^https:\/\//u.test(input.sourceUrl) || input.sourceUrl.length > 2048)) fail("sourceUrl must be an HTTPS URL");
  if (input.licenseSpdx !== undefined && (typeof input.licenseSpdx !== "string" || !/^[A-Za-z0-9.-]+$/u.test(input.licenseSpdx) || input.licenseSpdx.length > 128)) fail("licenseSpdx is invalid");
  regularFile(artifact, "artifact");
  const stagingRoot = path.resolve(dataDir, "staging");
  const staged = path.resolve(stagingRoot, artifactId);
  if (!staged.startsWith(stagingRoot + path.sep)) fail("artifactId escaped staging");
  if (fs.existsSync(staged)) fail("staging artifact already exists");
  fs.mkdirSync(stagingRoot, { recursive: true });
  fs.copyFileSync(artifact, staged, fs.constants.COPYFILE_EXCL);
  if (digest(artifact) !== digest(staged)) {
    fs.rmSync(staged, { force: true });
    fail("staged artifact digest differs from source");
  }
  const release = {
    schemaVersion: 1,
    keyId: "replace-with-trusted-key-fingerprint",
    componentId,
    version: releaseVersion,
    artifactId,
    sha256: digest(staged),
    platform: releasePlatform,
    ...(typeof input.sourceUrl === "string" || typeof input.licenseSpdx === "string" ? {
      provenance: {
        ...(typeof input.sourceUrl === "string" ? { sourceUrl: input.sourceUrl } : {}),
        ...(typeof input.licenseSpdx === "string" ? { licenseSpdx: input.licenseSpdx } : {})
      }
    } : {})
  };
  return { stagingPath: staged, release };
}

function parse(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]; const value = args[index + 1];
    if (!["--data-dir", "--artifact", "--component-id", "--artifact-id", "--version", "--platform", "--source-url", "--license-spdx", "--output"].includes(key) || value === undefined || value.startsWith("--")) fail("usage: prepare-component-release --data-dir <path> --artifact <path> --component-id <id> --artifact-id <id> --version <semver> --platform <windows-x64|linux-x64|linux-arm64> [--source-url <https-url>] [--license-spdx <id>] [--output <path>]");
    values.set(key, value);
  }
  const get = (key) => values.get(key);
  return { dataDir: get("--data-dir"), artifact: get("--artifact"), componentId: get("--component-id"), artifactId: get("--artifact-id"), version: get("--version"), platform: get("--platform"), ...(get("--source-url") === undefined ? {} : { sourceUrl: get("--source-url") }), ...(get("--license-spdx") === undefined ? {} : { licenseSpdx: get("--license-spdx") }), ...(get("--output") === undefined ? {} : { output: get("--output") }) };
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = parse(process.argv.slice(2).filter((value) => value !== "--"));
    const prepared = prepareComponentRelease(input);
    const output = JSON.stringify({ release: prepared.release }, null, 2) + "\n";
    if (typeof input.output === "string") {
      const outputPath = path.resolve(input.output);
      if (fs.existsSync(outputPath)) fail("output already exists");
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, output, { encoding: "utf8", flag: "wx" });
    }
    process.stdout.write(JSON.stringify({ stagingPath: prepared.stagingPath, release: prepared.release }) + "\n");
  } catch (error) { console.error(error instanceof Error ? error.message : "Component release preparation failed"); process.exitCode = 1; }
}
