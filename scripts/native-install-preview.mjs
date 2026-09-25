import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeNativeInstallActions } from "./native-install-executor.mjs";

function fail(message) { throw new Error(`Native install preview failed: ${message}`); }

function parse(args) {
  const normalized = args.filter((value) => value !== "--");
  if (normalized.length !== 2 || normalized[0] !== "--plan" || normalized[1].startsWith("--")) fail("usage: native-install-preview --plan <plan.json>");
  return path.resolve(normalized[1]);
}

export function previewNativeInstallPlan(plan) {
  if (plan === null || typeof plan !== "object") fail("plan must be an object");
  if (plan.schemaVersion !== 1) fail("plan schemaVersion must be 1");
  if (plan.platform !== "linux" && plan.platform !== "windows") fail("plan platform is invalid");
  for (const key of ["bundle", "resources", "service", "serviceAccount", "acl"]) {
    if (plan[key] === undefined || plan[key] === null) fail(`plan is missing ${key}`);
  }
  if (typeof plan.serviceAccount !== "string" || plan.serviceAccount.length === 0) fail("plan serviceAccount is invalid");
  if (!Array.isArray(plan.acl) || plan.acl.length === 0) fail("plan acl is invalid");
  if (!Array.isArray(plan.actions)) fail("plan actions must be an array");
  return executeNativeInstallActions(plan.actions, plan.platform);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const planPath = parse(process.argv.slice(2));
    const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    console.log(JSON.stringify({ plan: planPath, ...previewNativeInstallPlan(plan) }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Native install preview failed");
    process.exitCode = 1;
  }
}
