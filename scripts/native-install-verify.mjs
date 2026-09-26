import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { commandPaths } from "./native-install-executor.mjs";
import { validateNativeInstallActions } from "./native-install-actions.mjs";

function fail(message) { throw new Error(`Native install verification failed: ${message}`); }

function absolute(value, platform, label) {
  if (typeof value !== "string" || value.length === 0 || /[\u0000\r\n]/u.test(value)) fail(`${label} is invalid`);
  if (!(platform === "windows" ? path.win32.isAbsolute(value) : path.posix.isAbsolute(value))) fail(`${label} must be absolute`);
  return value;
}

function validatePlan(plan) {
  if (plan === null || typeof plan !== "object" || plan.schemaVersion !== 1) fail("plan schemaVersion must be 1");
  if (plan.platform !== "windows" && plan.platform !== "linux") fail("plan platform is invalid");
  if (plan.resources === null || typeof plan.resources !== "object" || plan.service === null || typeof plan.service !== "object") fail("plan resources and service are required");
  absolute(plan.resources.bundleRoot, plan.platform, "bundleRoot");
  absolute(plan.resources.configPath, plan.platform, "configPath");
  absolute(plan.resources.dataDir, plan.platform, "dataDir");
  if (typeof plan.serviceAccount !== "string" || plan.serviceAccount.length === 0 || /[\u0000\r\n]/u.test(plan.serviceAccount)) fail("plan serviceAccount is invalid");
  if (typeof plan.service.serviceName !== "string" || plan.service.serviceName.length === 0 || /[\u0000\r\n]/u.test(plan.service.serviceName)) fail("plan service name is invalid");
  validateNativeInstallActions(plan.actions, plan.platform);
  return plan;
}

function selectedCommandPaths(platform, overrides = {}) {
  const selected = { ...commandPaths[platform], ...overrides };
  for (const [command, executable] of Object.entries(selected)) absolute(executable, platform, `command path for ${command}`);
  return selected;
}

function defaultRun(executable, args) {
  const result = spawnSync(executable, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  if (result.error !== undefined) fail(`could not start ${path.basename(executable)}: ${result.error.message}`);
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

function check(name, passed, details) { return { name, passed, details }; }

function hasMatchingAccount(passwd, account) {
  const record = passwd.split(/\r?\n/u).find((line) => line.startsWith(`${account}:`));
  if (record === undefined) return false;
  const fields = record.split(":");
  return fields.length >= 7 && fields[6] === "/usr/sbin/nologin";
}

function readRequired(readFile, location) {
  try { return readFile(location, "utf8"); }
  catch { fail(`required native state is unavailable: ${location}`); }
}

function verifyLinux(plan, paths, run, readFile) {
  const unitAction = plan.actions.find((item) => item.command === "install" && item.args.at(-2) === "/dev/stdin");
  const unitPath = `/etc/systemd/system/${plan.service.unitName}`;
  const checks = [
    check("service-account", hasMatchingAccount(readRequired(readFile, "/etc/passwd"), plan.serviceAccount), `account=${plan.serviceAccount}`),
    check("systemd-unit", unitAction !== undefined && unitAction.args.at(-1) === unitPath && readRequired(readFile, unitPath) === unitAction.stdin, `unit=${unitPath}`),
  ];
  for (const [name, args] of [["service-enabled", ["is-enabled", plan.service.unitName]], ["service-active", ["is-active", plan.service.unitName]]]) {
    const result = run(paths.systemctl, args);
    checks.push(check(name, result.status === 0, `${args.join(" ")}: ${result.stdout.trim() || result.stderr.trim()}`));
  }
  return checks;
}

function verifyWindows(plan, paths, run) {
  const create = plan.actions.find((item) => item.command === "sc.exe" && item.args[0] === "create");
  if (create === undefined) fail("windows service create action is unavailable");
  const expectedPath = create.args.find((value) => value.startsWith("binPath= "))?.slice("binPath= ".length).trim();
  const expectedAccount = create.args.find((value) => value.startsWith("obj= "))?.slice("obj= ".length).trim().replace(/^"|"$/gu, "");
  const config = run(paths["sc.exe"], ["qc", plan.service.serviceName]);
  const state = run(paths["sc.exe"], ["query", plan.service.serviceName]);
  const configText = `${config.stdout}\n${config.stderr}`;
  return [
    check("service-config", config.status === 0 && expectedPath !== undefined && expectedAccount !== undefined && configText.includes(expectedPath) && configText.includes(expectedAccount), `service=${plan.service.serviceName}`),
    check("service-active", state.status === 0 && /STATE\s*:\s*\d+\s+RUNNING/iu.test(`${state.stdout}\n${state.stderr}`), `service=${plan.service.serviceName}`),
  ];
}

/** Reads a native deployment after apply; it never changes files, accounts, ACLs, or services. */
export function verifyNativeInstallPlan(plan, options = {}) {
  const verifiedPlan = validatePlan(plan);
  const paths = selectedCommandPaths(verifiedPlan.platform, options.commandPaths);
  const run = options.run ?? defaultRun;
  const readFile = options.readFile ?? fs.readFileSync;
  const checks = verifiedPlan.platform === "linux"
    ? verifyLinux(verifiedPlan, paths, run, readFile)
    : verifyWindows(verifiedPlan, paths, run);
  return { platform: verifiedPlan.platform, verified: checks.every((item) => item.passed), checks };
}

function parse(args) {
  const normalized = args.filter((value) => value !== "--");
  if (normalized.length !== 2 || normalized[0] !== "--plan" || normalized[1].startsWith("--")) fail("usage: native-install-verify --plan <plan.json>");
  return path.resolve(normalized[1]);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const planPath = parse(process.argv.slice(2));
    const result = verifyNativeInstallPlan(JSON.parse(fs.readFileSync(planPath, "utf8")));
    console.log(JSON.stringify({ plan: planPath, ...result }));
    if (!result.verified) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Native install verification failed");
    process.exitCode = 1;
  }
}
