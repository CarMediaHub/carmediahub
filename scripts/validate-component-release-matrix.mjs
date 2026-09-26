import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const platformPattern = /^(?:windows|linux|darwin)-(?:x64|arm64)$/u;
const identifier = /^[a-z][a-z0-9-]{1,63}$/u;
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const digest = /^[a-f0-9]{64}$/u;
const keyId = /^[a-f0-9]{16}$/u;
const base64 = /^[A-Za-z0-9+/]+={0,2}$/u;

function fail(message) { throw new Error(`Component release matrix validation failed: ${message}`); }
function requireString(value, label, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) fail(`${label} is invalid`);
  return value;
}

export function validateComponentReleaseMatrix(matrix, options = {}) {
  if (matrix === null || typeof matrix !== "object" || Array.isArray(matrix)) fail("matrix must be an object");
  if (matrix.schemaVersion !== 1) fail("unsupported schemaVersion");
  const componentId = requireString(matrix.componentId, "componentId", identifier);
  const version = requireString(matrix.version, "version", semver);
  if (!Array.isArray(matrix.platforms) || matrix.platforms.length === 0) fail("platforms must be a non-empty array");
  const expected = new Set(matrix.platforms.map((item) => requireString(item, "platform", platformPattern)));
  if (expected.size !== matrix.platforms.length) fail("platforms must be unique");
  if (!Array.isArray(matrix.releases) || matrix.releases.length !== expected.size) fail("releases must contain one record per platform");
  const seen = new Set();
  for (const [index, signed] of matrix.releases.entries()) {
    if (signed === null || typeof signed !== "object" || Array.isArray(signed)) fail(`release ${index} must be an object`);
    if (!base64.test(signed.signature ?? "")) fail(`release ${index} signature is invalid`);
    const release = signed.release;
    if (release === null || typeof release !== "object" || Array.isArray(release)) fail(`release ${index} payload is invalid`);
    if (release.schemaVersion !== 1) fail(`release ${index} schemaVersion is invalid`);
    if (release.componentId !== componentId) fail(`release ${index} componentId does not match matrix`);
    if (release.version !== version) fail(`release ${index} version does not match matrix`);
    requireString(release.keyId, `release ${index} keyId`, keyId);
    requireString(release.artifactId, `release ${index} artifactId`, identifier);
    requireString(release.sha256, `release ${index} sha256`, digest);
    const releasePlatform = requireString(release.platform, `release ${index} platform`, platformPattern);
    if (!expected.has(releasePlatform) || seen.has(releasePlatform)) fail(`release ${index} platform is missing or duplicated`);
    seen.add(releasePlatform);
    if (release.provenance === undefined || typeof release.provenance !== "object" || !/^https:\/\//u.test(release.provenance.sourceUrl ?? "") || typeof release.provenance.licenseSpdx !== "string") fail(`release ${index} provenance is incomplete`);
  }
  if (options.catalog !== undefined) {
    if (options.catalog === null || typeof options.catalog !== "object" || !Array.isArray(options.catalog.components)) fail("catalog is invalid");
    const component = options.catalog.components.find((item) => item?.id === componentId);
    if (component === undefined) fail(`component is not declared in catalog: ${componentId}`);
    if (!Array.isArray(component.platforms) || component.platforms.length !== expected.size || component.platforms.some((item) => !expected.has(item))) fail(`platforms do not match catalog for ${componentId}`);
  }
  return { componentId, version, platforms: [...seen].sort() };
}

function parse(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]; const value = args[index + 1];
    if (!["--matrix", "--catalog"].includes(key) || value === undefined || value.startsWith("--")) fail("usage: validate-component-release-matrix --matrix <path> [--catalog <path>]");
    values.set(key, value);
  }
  if (!values.has("--matrix")) fail("usage: validate-component-release-matrix --matrix <path> [--catalog <path>]");
  return values;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const values = parse(process.argv.slice(2).filter((value) => value !== "--"));
    const matrix = JSON.parse(fs.readFileSync(path.resolve(values.get("--matrix")), "utf8"));
    const catalog = values.has("--catalog") ? JSON.parse(fs.readFileSync(path.resolve(values.get("--catalog")), "utf8")) : undefined;
    process.stdout.write(`${JSON.stringify(validateComponentReleaseMatrix(matrix, { catalog }))}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Component release matrix validation failed");
    process.exitCode = 1;
  }
}
