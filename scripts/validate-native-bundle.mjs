import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) { throw new Error(`Native bundle validation failed: ${message}`); }
function requiredFile(bundleRoot, relative, allowDependencySymlink = false) {
  const location = path.join(bundleRoot, relative);
  let current = bundleRoot;
  for (const segment of relative.split(/[\\/]+/u)) {
    current = path.join(current, segment);
    let stat;
    try { stat = fs.lstatSync(current); } catch { fail(`missing file: ${relative}`); }
    if (stat.isSymbolicLink() && !(allowDependencySymlink && relative.startsWith("node_modules/"))) fail(`symbolic link is not allowed: ${relative}`);
  }
  if (!fs.lstatSync(location).isFile()) fail(`missing file: ${relative}`);
}

export function validateNativeBundle(bundleRoot, options = {}) {
  if (!path.isAbsolute(bundleRoot)) fail("bundle root must be absolute");
  if (!fs.existsSync(bundleRoot) || !fs.lstatSync(bundleRoot).isDirectory() || fs.lstatSync(bundleRoot).isSymbolicLink()) fail("bundle root is unavailable or symbolic");
  const required = ["dist/cli.js", "public/admin/index.html", "scripts/upgrade-preflight.mjs", "scripts/native-install-plan.mjs", "scripts/native-windows-service.mjs", "scripts/native-linux-service.mjs", "scripts/validate-native-bundle.mjs", "config/components.json", "config/components.schema.json", "config/core.schema.json", "config/core.example.json", "package.json", "node_modules/fastify/package.json", "node_modules/@fastify/cookie/package.json", "node_modules/pg/package.json", "node_modules/@carmediahub/sdk/package.json", "node_modules/@carmediahub/sdk/dist/index.js"];
  for (const relative of required) requiredFile(bundleRoot, relative, options.allowDependencySymlinks === true);
  for (const forbidden of ["config/core.json", ".env", ".env.production"]) {
    if (fs.existsSync(path.join(bundleRoot, forbidden))) fail(`instance secret/configuration file is present: ${forbidden}`);
  }
  const packageJson = JSON.parse(fs.readFileSync(path.join(bundleRoot, "package.json"), "utf8"));
  if (packageJson.type !== "module" || packageJson.private !== true || typeof packageJson.version !== "string") fail("runtime package metadata is incomplete");
  if (!Number.isSafeInteger(packageJson.carmediahub?.databaseSchemaVersion) || packageJson.carmediahub.databaseSchemaVersion < 1) fail("database schema metadata is incomplete");
  return { files: required.length, packageVersion: packageJson.version, databaseSchemaVersion: packageJson.carmediahub.databaseSchemaVersion };
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bundleRoot = process.argv[2] === undefined ? root : path.resolve(process.argv[2]);
  console.log(JSON.stringify(validateNativeBundle(bundleRoot, { allowDependencySymlinks: process.argv[2] === undefined })));
}
