import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function fail(message) { throw new Error(`Resource preflight failed: ${message}`); }

function absolute(value, label) {
  if (typeof value !== "string" || value.length === 0 || !path.isAbsolute(value)) fail(`${label} must be an absolute path`);
  return path.resolve(value);
}

function requiredBytes(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail("requiredFreeBytes must be a non-negative safe integer");
  return value;
}

function existingParent(location) {
  let current = path.resolve(location);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) fail("dataDir has no existing parent");
    current = parent;
  }
  if (!fs.statSync(current).isDirectory()) fail("dataDir parent is unavailable");
  return current;
}

export function checkDeploymentResources(input, dependencies = { statfs: fs.statfsSync }) {
  const bundleRoot = absolute(input.bundleRoot, "bundleRoot");
  const configPath = absolute(input.configPath, "configPath");
  const dataDir = absolute(input.dataDir, "dataDir");
  const requiredFreeBytes = requiredBytes(input.requiredFreeBytes);
  if (!fs.existsSync(bundleRoot) || !fs.statSync(bundleRoot).isDirectory()) fail("bundleRoot is unavailable");
  if (!fs.existsSync(configPath) || !fs.statSync(configPath).isFile()) fail("configPath is unavailable");
  const dataParent = existingParent(dataDir);
  const stats = dependencies.statfs(dataParent);
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  if (!Number.isSafeInteger(freeBytes) || freeBytes < requiredFreeBytes) fail(`insufficient free space: ${freeBytes} bytes available, ${requiredFreeBytes} required`);
  return { bundleRoot, configPath, dataDir, freeBytes, requiredFreeBytes };
}

function parse(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!["--bundle-root", "--config", "--data-dir", "--required-free-bytes"].includes(key) || value === undefined || value.startsWith("--")) fail("usage: check:resources --bundle-root <path> --config <path> --data-dir <path> --required-free-bytes <bytes>");
    values.set(key, value);
  }
  const required = (key) => { const value = values.get(key); if (value === undefined) fail(`${key} is required`); return value; };
  const parsedBytes = Number(required("--required-free-bytes"));
  return { bundleRoot: required("--bundle-root"), configPath: required("--config"), dataDir: required("--data-dir"), requiredFreeBytes: parsedBytes };
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(checkDeploymentResources(parse(process.argv.slice(2).filter((value) => value !== "--"))))); }
  catch (error) { console.error(error instanceof Error ? error.message : "Resource preflight failed"); process.exitCode = 1; }
}
