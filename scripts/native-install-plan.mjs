import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateNativeBundle } from "./validate-native-bundle.mjs";
import { checkDeploymentResources } from "./preflight-resources.mjs";
import { createWindowsServiceSpec } from "./native-windows-service.mjs";
import { createLinuxServiceSpec } from "./native-linux-service.mjs";
import { createNativeInstallActions, validateNativeInstallActions } from "./native-install-actions.mjs";

function fail(message) { throw new Error(`Native install plan failed: ${message}`); }

function account(value, platform) {
  const selected = value ?? (platform === "windows" ? "NT AUTHORITY\\LocalService" : "carmediahub");
  if (typeof selected !== "string" || selected.length === 0 || selected.length > 128 || /[\r\n]/u.test(selected)) fail("serviceAccount is invalid");
  if (platform === "windows" && (!/^[A-Za-z0-9._$ -]{1,96}(?:\\[A-Za-z0-9._$ -]{1,96})?$/u.test(selected) || selected.startsWith(" ") || selected.endsWith(" "))) fail("serviceAccount is invalid for Windows");
  if (platform === "linux" && !/^[a-z_][a-z0-9_-]{0,31}$/u.test(selected)) fail("serviceAccount is invalid for Linux");
  return selected;
}

export function createNativeInstallPlan(input, dependencies) {
  if (input.platform !== "windows" && input.platform !== "linux") fail("platform must be windows or linux");
  if (typeof input.nodePath !== "string" || input.nodePath.length === 0) fail("nodePath is required");
  if (typeof input.serviceName !== "string" || input.serviceName.length === 0) fail("serviceName is required");
  if (typeof input.description !== "string" || input.description.length === 0) fail("description is required");
  const bundle = validateNativeBundle(input.bundleRoot);
  const resources = (dependencies?.checkResources ?? checkDeploymentResources)({ bundleRoot: input.bundleRoot, configPath: input.configPath, dataDir: input.dataDir, requiredFreeBytes: input.requiredFreeBytes }, dependencies);
  const serviceAccount = account(input.serviceAccount, input.platform);
  const service = input.platform === "windows"
    ? createWindowsServiceSpec({ serviceName: input.serviceName, displayName: input.displayName ?? input.description, description: input.description, serviceAccount, nodePath: input.nodePath, bundleRoot: resources.bundleRoot, dataDir: resources.dataDir, configPath: resources.configPath })
    : createLinuxServiceSpec({ serviceName: input.serviceName, description: input.description, serviceAccount, nodePath: input.nodePath, bundleRoot: resources.bundleRoot, dataDir: resources.dataDir, configPath: resources.configPath });
  const plan = { schemaVersion: 1, platform: input.platform, bundle, resources, service, serviceAccount, acl: [{ path: resources.bundleRoot, access: "read-execute" }, { path: resources.configPath, access: "read-only" }, { path: resources.dataDir, access: "read-write" }] };
  const actions = validateNativeInstallActions(createNativeInstallActions(plan), input.platform);
  return { ...plan, actions };
}

function parse(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]; const value = args[index + 1];
    if (!["--platform", "--bundle-root", "--config", "--data-dir", "--node", "--service-name", "--description", "--display-name", "--service-account", "--required-free-bytes"].includes(key) || value === undefined || value.startsWith("--")) fail("usage: native-install-plan --platform <windows|linux> --bundle-root <path> --config <path> --data-dir <path> --node <path> --service-name <name> --description <text> --service-account <account> --required-free-bytes <bytes>");
    values.set(key, value);
  }
  const required = (key) => { const value = values.get(key); if (value === undefined) fail(`${key} is required`); return value; };
  return { platform: required("--platform"), bundleRoot: required("--bundle-root"), configPath: required("--config"), dataDir: required("--data-dir"), nodePath: required("--node"), serviceName: required("--service-name"), description: required("--description"), ...(values.has("--display-name") ? { displayName: values.get("--display-name") } : {}), ...(values.has("--service-account") ? { serviceAccount: values.get("--service-account") } : {}), requiredFreeBytes: Number(required("--required-free-bytes")) };
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(createNativeInstallPlan(parse(process.argv.slice(2).filter((value) => value !== "--"))))); }
  catch (error) { console.error(error instanceof Error ? error.message : "Native install plan failed"); process.exitCode = 1; }
}
