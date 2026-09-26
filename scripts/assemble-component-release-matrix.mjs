import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateComponentReleaseMatrix } from "./validate-component-release-matrix.mjs";

const identifier = /^[a-z][a-z0-9-]{1,63}$/u;
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const platform = /^(?:windows|linux|darwin)-(?:x64|arm64)$/u;

function fail(message) { throw new Error(`Component release matrix assembly failed: ${message}`); }
function required(value, label) { if (typeof value !== "string" || value.length === 0) fail(`${label} is required`); return value; }

export function assembleComponentReleaseMatrix(input) {
  const componentId = required(input.componentId, "componentId");
  const version = required(input.version, "version");
  if (!identifier.test(componentId) || !semver.test(version)) fail("componentId or version is invalid");
  if (!Array.isArray(input.platforms) || input.platforms.length === 0 || input.platforms.some((item) => typeof item !== "string" || !platform.test(item)) || new Set(input.platforms).size !== input.platforms.length) fail("platforms must be unique platform identifiers");
  if (!Array.isArray(input.releases) || input.releases.length !== input.platforms.length) fail("one signed release is required for every platform");
  const matrix = { schemaVersion: 1, componentId, version, platforms: input.platforms, releases: input.releases };
  validateComponentReleaseMatrix(matrix, { catalog: input.catalog });
  return matrix;
}

function parse(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]; const value = args[index + 1];
    if (!["--component-id", "--version", "--platforms", "--release-dir", "--output", "--catalog"].includes(key) || value === undefined || value.startsWith("--")) fail("usage: assemble-component-release-matrix --component-id <id> --version <semver> --platforms <comma-separated-platforms> --release-dir <signed-json-dir> --output <matrix.json> [--catalog <path>]");
    values.set(key, value);
  }
  return { componentId: values.get("--component-id"), version: values.get("--version"), platforms: values.get("--platforms")?.split(","), releaseDir: values.get("--release-dir"), output: values.get("--output"), catalogPath: values.get("--catalog") };
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = parse(process.argv.slice(2).filter((value) => value !== "--"));
    const releaseDir = path.resolve(required(input.releaseDir, "release-dir"));
    const files = fs.readdirSync(releaseDir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".json")).sort((left, right) => left.name.localeCompare(right.name));
    if (files.length === 0) fail("release-dir contains no JSON records");
    const releases = files.map((entry) => JSON.parse(fs.readFileSync(path.join(releaseDir, entry.name), "utf8")));
    const catalog = input.catalogPath === undefined ? undefined : JSON.parse(fs.readFileSync(path.resolve(input.catalogPath), "utf8"));
    const matrix = assembleComponentReleaseMatrix({ ...input, releases, catalog });
    const output = path.resolve(required(input.output, "output"));
    if (fs.existsSync(output)) fail("output already exists");
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(matrix, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    process.stdout.write(`${JSON.stringify({ output, componentId: matrix.componentId, version: matrix.version, platforms: matrix.platforms })}\n`);
  } catch (error) { console.error(error instanceof Error ? error.message : "Component release matrix assembly failed"); process.exitCode = 1; }
}
