import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { executeNativeInstallActions } from "./native-install-executor.mjs";
import { validateNativeInstallActions } from "./native-install-actions.mjs";

function fail(message) { throw new Error(`Native install apply failed: ${message}`); }

function parse(args) {
  const normalized = args.filter((value) => value !== "--");
  if (normalized.length === 2 && normalized[0] === "--plan" && !normalized[1].startsWith("--")) return { planPath: path.resolve(normalized[1]), apply: false };
  if (normalized.length === 5 && normalized[0] === "--plan" && !normalized[1].startsWith("--") && normalized[2] === "--apply" && normalized[3] === "--confirm" && normalized[4] === "CARMEDIAHUB_APPLY") return { planPath: path.resolve(normalized[1]), apply: true, confirm: normalized[4] };
  fail("usage: native-install-apply --plan <plan.json> [--apply --confirm CARMEDIAHUB_APPLY]");
}

function run(executable, args) {
  const result = spawnSync(executable, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

function createEnsureInspector(platform) {
  if (platform === "windows") {
    return (item, executable) => {
      if (item.command !== "sc.exe" || item.args[0] !== "create") return "missing";
      const result = run(executable, ["query", item.args[1]]);
      if (result.status === 1060 || /does not exist/iu.test(result.stdout + result.stderr)) return "missing";
      if (result.status === 0) {
        const config = run(executable, ["qc", item.args[1]]);
        const expectedPath = item.args.find((value) => value.startsWith("binPath= "))?.slice("binPath= ".length).trim();
        const expectedAccount = item.args.find((value) => value.startsWith("obj= "))?.slice("obj= ".length).trim();
        if (config.status === 0 && expectedPath !== undefined && expectedAccount !== undefined && config.stdout.includes(expectedPath) && config.stdout.includes(expectedAccount)) return "matching";
        return "mismatch";
      }
      fail(`could not inspect Windows service ${item.args[1]}`);
    };
  }
  return (item) => {
    if (item.command !== "useradd") return "missing";
    const account = item.args.at(-1);
    const record = fs.readFileSync("/etc/passwd", "utf8").split(/\r?\n/u).find((line) => line.startsWith(`${account}:`));
    if (record === undefined) return "missing";
    const fields = record.split(":");
    return fields[6] === "/usr/sbin/nologin" ? "matching" : "mismatch";
  };
}

export function applyNativeInstallPlan(plan, options = {}) {
  if (plan === null || typeof plan !== "object" || plan.schemaVersion !== 1) fail("plan schemaVersion must be 1");
  if (plan.platform !== "windows" && plan.platform !== "linux") fail("plan platform is invalid");
  validateNativeInstallActions(plan.actions, plan.platform);
  const apply = options.apply === true;
  if (apply && options.confirm !== "CARMEDIAHUB_APPLY") fail("--apply requires explicit confirmation CARMEDIAHUB_APPLY");
  return executeNativeInstallActions(plan.actions, plan.platform, {
    apply,
    ...(apply ? { inspectEnsure: options.inspectEnsure ?? createEnsureInspector(plan.platform) } : {}),
    ...(options.execute === undefined ? {} : { execute: options.execute }),
    ...(options.commandPaths === undefined ? {} : { commandPaths: options.commandPaths }),
  });
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = parse(process.argv.slice(2));
    const plan = JSON.parse(fs.readFileSync(input.planPath, "utf8"));
    const result = applyNativeInstallPlan(plan, input.apply ? { apply: true, confirm: input.confirm } : {});
    console.log(JSON.stringify({ plan: input.planPath, ...result }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Native install apply failed");
    process.exitCode = 1;
  }
}
