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

function inspectReleaseArtifacts(bundleRoot) {
  const candidates = [];
  const visit = (relative) => {
    const location = path.join(bundleRoot, relative);
    const stat = fs.lstatSync(location);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(location)) visit(path.join(relative, entry));
      return;
    }
    if (stat.isFile() && /\.(?:cjs|css|d\.ts|html|js|json|mjs)$/u.test(relative) && !relative.endsWith(".map")) candidates.push(location);
  };
  visit("dist");
  visit("public");
  for (const relative of ["package.json", "config/components.json", "config/components.schema.json", "config/component-release.schema.json", "config/component-release-matrix.schema.json", "config/native-install-plan.schema.json", "config/core.schema.json", "config/core.example.json"]) visit(relative);

  const forbidden = [
    { name: "workspace path", pattern: /(?:[A-Za-z]:[\\/]+(?:projects|workspace)[\\/]+[^\r\n"']*CarMediaHub|[\\/]workspace[\\/]+carmediahub(?:[\\/]|\b))/iu },
    { name: "private key", pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u },
    { name: "GitHub token", pattern: /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/u },
    { name: "cloud access key", pattern: /\bAKIA[0-9A-Z]{16}\b/u },
    { name: "test secret", pattern: /CMH_TEST_SECRET|must-not-cross-worker-boundary/u }
  ];
  for (const location of candidates) {
    const content = fs.readFileSync(location, "utf8");
    for (const rule of forbidden) {
      if (rule.pattern.test(content)) fail(`${rule.name} found in release artifact: ${path.relative(bundleRoot, location)}`);
    }
  }
}

export function validateNativeBundle(bundleRoot, options = {}) {
  if (!path.isAbsolute(bundleRoot)) fail("bundle root must be absolute");
  if (!fs.existsSync(bundleRoot) || !fs.lstatSync(bundleRoot).isDirectory() || fs.lstatSync(bundleRoot).isSymbolicLink()) fail("bundle root is unavailable or symbolic");
  const required = ["dist/cli.js", "dist/backup-cli.js", "public/admin/index.html", "scripts/upgrade-preflight.mjs", "scripts/native-install-plan.mjs", "scripts/native-install-actions.mjs", "scripts/native-install-executor.mjs", "scripts/native-install-apply.mjs", "scripts/native-install-verify.mjs", "scripts/native-windows-service.mjs", "scripts/native-linux-service.mjs", "scripts/validate-native-bundle.mjs", "config/components.json", "config/components.schema.json", "config/component-release.schema.json", "config/component-release-matrix.schema.json", "config/native-install-plan.schema.json", "config/core.schema.json", "config/core.example.json", "package.json", "node_modules/fastify/package.json", "node_modules/avvio/package.json", "node_modules/@fastify/cookie/package.json", "node_modules/pg/package.json", "node_modules/@carmediahub/sdk/package.json", "node_modules/@carmediahub/sdk/dist/index.js"];
  for (const relative of required) requiredFile(bundleRoot, relative, options.allowDependencySymlinks === true);
  for (const forbidden of ["config/core.json", ".env", ".env.production"]) {
    if (fs.existsSync(path.join(bundleRoot, forbidden))) fail(`instance secret/configuration file is present: ${forbidden}`);
  }
  inspectReleaseArtifacts(bundleRoot);
  const packageJson = JSON.parse(fs.readFileSync(path.join(bundleRoot, "package.json"), "utf8"));
  if (packageJson.type !== "module" || packageJson.private !== true || typeof packageJson.version !== "string") fail("runtime package metadata is incomplete");
  if (!Number.isSafeInteger(packageJson.carmediahub?.databaseSchemaVersion) || packageJson.carmediahub.databaseSchemaVersion < 1) fail("database schema metadata is incomplete");
  return { files: required.length, packageVersion: packageJson.version, databaseSchemaVersion: packageJson.carmediahub.databaseSchemaVersion };
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const requested = process.argv.slice(2).find((value) => value !== "--");
  const bundleRoot = requested === undefined ? root : path.resolve(requested);
  console.log(JSON.stringify(validateNativeBundle(bundleRoot, { allowDependencySymlinks: requested === undefined })));
}
