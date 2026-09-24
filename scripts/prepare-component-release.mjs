import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const identifier = /^[a-z][a-z0-9-]{1,63}$/u;
const version = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const platform = /^(?:windows|linux)-(?:x64|arm64)$/u;
const keyIdPattern = /^[a-f0-9]{16}$/u;

function fail(message) { throw new Error(`Component release preparation failed: ${message}`); }

function required(input, key) {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) fail(`${key} is required`);
  return value;
}

function regularArtifact(location, label) {
  let stat;
  try { stat = fs.lstatSync(location); } catch { fail(`${label} does not exist`); }
  if ((!stat.isFile() && !stat.isDirectory()) || stat.isSymbolicLink()) fail(`${label} must be a regular file or directory`);
}

function fileDigest(location) {
  return crypto.createHash("sha256").update(fs.readFileSync(location)).digest("hex");
}

function collectFiles(root, current = root, entries = []) {
  for (const item of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const location = path.join(current, item.name);
    const relative = path.relative(root, location).split(path.sep).join("/");
    if (item.isSymbolicLink() || item.isBlockDevice() || item.isCharacterDevice() || item.isFIFO() || item.isSocket()) fail("artifact contains an unsupported file type");
    if (item.isDirectory()) collectFiles(root, location, entries);
    else if (item.isFile()) entries.push(relative);
    else fail("artifact contains an unsupported directory entry");
  }
  return entries;
}

function digest(location) {
  const stat = fs.lstatSync(location);
  if (stat.isFile()) return fileDigest(location);
  const hash = crypto.createHash("sha256");
  for (const relative of collectFiles(location).sort()) hash.update(`${relative}\0${fileDigest(path.join(location, relative))}\n`, "utf8");
  return hash.digest("hex");
}

function copyArtifact(source, target) {
  const stat = fs.lstatSync(source);
  if (stat.isFile()) {
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    return;
  }
  fs.mkdirSync(target, { recursive: true });
  for (const relative of collectFiles(source).sort()) {
    const destination = path.join(target, ...relative.split("/"));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(source, relative), destination, fs.constants.COPYFILE_EXCL);
  }
}

/** Copy an operator-selected binary into explicit staging and return an unsigned release record. */
export function prepareComponentRelease(input) {
  const dataDir = path.resolve(required(input, "dataDir"));
  const artifact = path.resolve(required(input, "artifact"));
  const componentId = required(input, "componentId");
  const artifactId = required(input, "artifactId");
  const releaseVersion = required(input, "version");
  const releasePlatform = required(input, "platform");
  const keyId = required(input, "keyId");
  if (!identifier.test(componentId) || !identifier.test(artifactId)) fail("componentId and artifactId must be lowercase identifiers");
  if (!version.test(releaseVersion)) fail("version must be semantic version 2");
  if (!platform.test(releasePlatform)) fail("platform must be windows-x64, linux-x64, or linux-arm64");
  if (!keyIdPattern.test(keyId)) fail("keyId must be a 16-character lowercase public-key fingerprint");
  if (input.sourceUrl !== undefined && (typeof input.sourceUrl !== "string" || !/^https:\/\//u.test(input.sourceUrl) || input.sourceUrl.length > 2048)) fail("sourceUrl must be an HTTPS URL");
  if (input.licenseSpdx !== undefined && (typeof input.licenseSpdx !== "string" || !/^[A-Za-z0-9.-]+$/u.test(input.licenseSpdx) || input.licenseSpdx.length > 128)) fail("licenseSpdx is invalid");
  if ((input.sourceUrl === undefined) !== (input.licenseSpdx === undefined)) fail("sourceUrl and licenseSpdx must be provided together");
  regularArtifact(artifact, "artifact");
  const stagingRoot = path.resolve(dataDir, "staging");
  const staged = path.resolve(stagingRoot, artifactId);
  if (!staged.startsWith(stagingRoot + path.sep)) fail("artifactId escaped staging");
  if (fs.existsSync(staged)) fail("staging artifact already exists");
  fs.mkdirSync(stagingRoot, { recursive: true });
  copyArtifact(artifact, staged);
  if (digest(artifact) !== digest(staged)) {
    fs.rmSync(staged, { force: true });
    fail("staged artifact digest differs from source");
  }
  const release = {
    schemaVersion: 1,
    keyId,
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
    if (!["--data-dir", "--artifact", "--component-id", "--artifact-id", "--version", "--platform", "--key-id", "--source-url", "--license-spdx", "--output"].includes(key) || value === undefined || value.startsWith("--")) fail("usage: prepare-component-release --data-dir <path> --artifact <path> --component-id <id> --artifact-id <id> --version <semver> --platform <windows-x64|linux-x64|linux-arm64> --key-id <16-hex-fingerprint> [--source-url <https-url>] [--license-spdx <id>] [--output <path>]");
    values.set(key, value);
  }
  const get = (key) => values.get(key);
  return { dataDir: get("--data-dir"), artifact: get("--artifact"), componentId: get("--component-id"), artifactId: get("--artifact-id"), version: get("--version"), platform: get("--platform"), keyId: get("--key-id"), ...(get("--source-url") === undefined ? {} : { sourceUrl: get("--source-url") }), ...(get("--license-spdx") === undefined ? {} : { licenseSpdx: get("--license-spdx") }), ...(get("--output") === undefined ? {} : { output: get("--output") }) };
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
