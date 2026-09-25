import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateNativeBundle } from "./validate-native-bundle.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function required(source, relative) {
  const location = path.join(source, relative);
  if (!fs.existsSync(location)) throw new Error(`Native bundle source is missing: ${relative}`);
  return location;
}

function copy(source, target) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    let resolved;
    try { resolved = fs.realpathSync(source); } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    return copy(resolved, target);
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source)) copy(path.join(source, entry), path.join(target, entry));
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
}

export function createNativeBundle(sourceRoot, outputRoot, options = {}) {
  if (!path.isAbsolute(sourceRoot) || !path.isAbsolute(outputRoot)) throw new Error("Native bundle paths must be absolute");
  const sourceResolved = path.resolve(sourceRoot);
  const outputResolved = path.resolve(outputRoot);
  const relativeOutput = path.relative(sourceResolved, outputResolved);
  if (relativeOutput === "" || (!relativeOutput.startsWith(".." + path.sep) && !path.isAbsolute(relativeOutput))) throw new Error("Native bundle output must be outside source");
  fs.mkdirSync(outputRoot, { recursive: true });
  const files = [
    "dist", "public", "scripts/upgrade-preflight.mjs", "scripts/native-install-plan.mjs", "scripts/native-install-actions.mjs", "scripts/native-windows-service.mjs", "scripts/native-linux-service.mjs", "scripts/validate-native-bundle.mjs", "config/components.json", "config/components.schema.json", "config/component-release.schema.json", "config/component-release-matrix.schema.json", "config/native-install-plan.schema.json",
    "config/core.schema.json", "config/core.example.json", "package.json", "node_modules"
  ];
  for (const relative of files) {
    if (relative === "node_modules") continue;
    copy(required(sourceRoot, relative), path.join(outputRoot, relative));
  }
  const runtimeNodeModules = options.runtimeNodeModules === undefined ? required(sourceRoot, "node_modules") : required(path.resolve(options.runtimeNodeModules), "");
  copy(runtimeNodeModules, path.join(outputRoot, "node_modules"));
  for (const forbidden of ["config/core.json", ".env", ".env.production"]) fs.rmSync(path.join(outputRoot, forbidden), { recursive: true, force: true });
  return validateNativeBundle(outputRoot);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter((value) => value !== "--");
  const runtimeIndex = args.indexOf("--runtime-node-modules");
  const runtimeNodeModules = runtimeIndex === -1 ? undefined : args[runtimeIndex + 1];
  if (runtimeIndex !== -1) args.splice(runtimeIndex, 2);
  const requested = args.find((value) => value !== "--");
  const output = requested === undefined ? path.resolve(root, "..", "carmediahub-native") : path.resolve(requested);
  console.log(JSON.stringify(createNativeBundle(root, output, runtimeNodeModules === undefined ? {} : { runtimeNodeModules })));
}
