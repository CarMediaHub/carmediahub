import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateNativeBundle } from "./validate-native-bundle.mjs";
import { checkUpgradePreflight } from "../dist/upgrade-preflight.js";

function fail(message) { throw new Error(`Upgrade preflight failed: ${message}`); }

function parse(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!["--bundle-root", "--data-dir", "--snapshot"].includes(key) || value === undefined || value.startsWith("--")) fail("usage: upgrade-preflight --bundle-root <path> --data-dir <path> --snapshot <path>");
    values.set(key, value);
  }
  const required = (key) => { const value = values.get(key); if (value === undefined || !path.isAbsolute(value)) fail(`${key} must be an absolute path`); return value; };
  return { bundleRoot: required("--bundle-root"), dataDir: required("--data-dir"), snapshot: required("--snapshot") };
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = parse(process.argv.slice(2).filter((value) => value !== "--"));
    const bundle = validateNativeBundle(input.bundleRoot);
    console.log(JSON.stringify(checkUpgradePreflight({ ...input, targetBundleVersion: bundle.packageVersion, targetSchemaVersion: bundle.databaseSchemaVersion })));
  } catch (error) { console.error(error instanceof Error ? error.message : "Upgrade preflight failed"); process.exitCode = 1; }
}
