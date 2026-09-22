import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateNativeBundle } from "./validate-native-bundle.mjs";
import { checkDeploymentResources } from "./preflight-resources.mjs";
import { createWindowsServiceSpec } from "./native-windows-service.mjs";
import { createLinuxServiceSpec } from "./native-linux-service.mjs";

function fail(message) { throw new Error(`Native install plan failed: ${message}`); }

export function createNativeInstallPlan(input, dependencies) {
  if (input.platform !== "windows" && input.platform !== "linux") fail("platform must be windows or linux");
  if (typeof input.nodePath !== "string" || input.nodePath.length === 0) fail("nodePath is required");
  if (typeof input.serviceName !== "string" || input.serviceName.length === 0) fail("serviceName is required");
  if (typeof input.description !== "string" || input.description.length === 0) fail("description is required");
  const bundle = validateNativeBundle(input.bundleRoot);
  const resources = (dependencies?.checkResources ?? checkDeploymentResources)({ bundleRoot: input.bundleRoot, configPath: input.configPath, dataDir: input.dataDir, requiredFreeBytes: input.requiredFreeBytes }, dependencies);
  const service = input.platform === "windows"
    ? createWindowsServiceSpec({ serviceName: input.serviceName, displayName: input.displayName ?? input.description, description: input.description, nodePath: input.nodePath, bundleRoot: resources.bundleRoot, dataDir: resources.dataDir, configPath: resources.configPath })
    : createLinuxServiceSpec({ serviceName: input.serviceName, description: input.description, nodePath: input.nodePath, bundleRoot: resources.bundleRoot, dataDir: resources.dataDir, configPath: resources.configPath });
  return { platform: input.platform, bundle, resources, service };
}

function parse(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]; const value = args[index + 1];
    if (!["--platform", "--bundle-root", "--config", "--data-dir", "--node", "--service-name", "--description", "--display-name", "--required-free-bytes"].includes(key) || value === undefined || value.startsWith("--")) fail("usage: native-install-plan --platform <windows|linux> --bundle-root <path> --config <path> --data-dir <path> --node <path> --service-name <name> --description <text> --required-free-bytes <bytes>");
    values.set(key, value);
  }
  const required = (key) => { const value = values.get(key); if (value === undefined) fail(`${key} is required`); return value; };
  return { platform: required("--platform"), bundleRoot: required("--bundle-root"), configPath: required("--config"), dataDir: required("--data-dir"), nodePath: required("--node"), serviceName: required("--service-name"), description: required("--description"), ...(values.has("--display-name") ? { displayName: values.get("--display-name") } : {}), requiredFreeBytes: Number(required("--required-free-bytes")) };
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(createNativeInstallPlan(parse(process.argv.slice(2).filter((value) => value !== "--"))))); }
  catch (error) { console.error(error instanceof Error ? error.message : "Native install plan failed"); process.exitCode = 1; }
}
