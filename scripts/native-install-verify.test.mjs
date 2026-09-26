import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyNativeInstallPlan } from "./native-install-verify.mjs";

const linuxPlan = {
  schemaVersion: 1,
  platform: "linux",
  resources: { bundleRoot: "/opt/carmediahub", configPath: "/etc/carmediahub/core.json", dataDir: "/var/lib/carmediahub" },
  service: { serviceName: "carmediahub-core", unitName: "carmediahub-core.service" },
  serviceAccount: "carmediahub",
  actions: [
    { command: "useradd", args: ["--system", "--no-create-home", "--shell", "/usr/sbin/nologin", "carmediahub"], description: "account", idempotency: "ensure" },
    { command: "install", args: ["-d", "-o", "carmediahub", "-g", "carmediahub", "-m", "0750", "/var/lib/carmediahub"], description: "data", idempotency: "repeatable" },
    { command: "install", args: ["-d", "-o", "root", "-g", "root", "-m", "0755", "/etc/carmediahub"], description: "config", idempotency: "repeatable" },
    { command: "install", args: ["-m", "0644", "--owner=root", "--group=root", "/dev/stdin", "/etc/systemd/system/carmediahub-core.service"], description: "unit", stdin: "[Unit]\nDescription=CarMediaHub Core\n", idempotency: "repeatable" },
    { command: "chown", args: ["-R", "carmediahub:carmediahub", "/var/lib/carmediahub"], description: "ownership", idempotency: "repeatable" },
    { command: "systemctl", args: ["daemon-reload"], description: "reload", idempotency: "repeatable" },
    { command: "systemctl", args: ["enable", "--now", "carmediahub-core.service"], description: "start", idempotency: "repeatable" },
  ],
};

test("verifies an applied Linux service without mutating the host", () => {
  const calls = [];
  const result = verifyNativeInstallPlan(linuxPlan, {
    readFile: (location) => location === "/etc/passwd" ? "carmediahub:x:10001:10001::/nonexistent:/usr/sbin/nologin\n" : "[Unit]\nDescription=CarMediaHub Core\n",
    run: (executable, args) => { calls.push({ executable, args }); return { status: 0, stdout: args[0] === "is-active" ? "active\n" : "enabled\n", stderr: "" }; },
  });
  assert.equal(result.verified, true);
  assert.deepEqual(calls.map((item) => item.args.join(" ")), ["is-enabled carmediahub-core.service", "is-active carmediahub-core.service"]);
});

test("reports Linux service drift without treating it as verified", () => {
  const result = verifyNativeInstallPlan(linuxPlan, {
    readFile: (location) => location === "/etc/passwd" ? "carmediahub:x:10001:10001::/nonexistent:/bin/bash\n" : "modified",
    run: () => ({ status: 3, stdout: "inactive\n", stderr: "" }),
  });
  assert.equal(result.verified, false);
  assert.equal(result.checks.filter((item) => !item.passed).length, 4);
});

test("verifies the Windows service identity and running state using explicit sc.exe", () => {
  const plan = structuredClone(linuxPlan);
  plan.platform = "windows";
  plan.resources = { bundleRoot: "C:\\Program Files\\CarMediaHub", configPath: "C:\\ProgramData\\CarMediaHub\\core.json", dataDir: "C:\\ProgramData\\CarMediaHub\\data" };
  plan.service = { serviceName: "CarMediaHubCore" };
  plan.serviceAccount = "NT AUTHORITY\\LocalService";
  plan.actions = [
    { command: "icacls.exe", args: [plan.resources.bundleRoot, "/grant", "NT AUTHORITY\\LocalService:(OI)(CI)(RX)"], description: "bundle", idempotency: "repeatable" },
    { command: "icacls.exe", args: [plan.resources.configPath, "/grant", "NT AUTHORITY\\LocalService:(R)"], description: "config", idempotency: "repeatable" },
    { command: "icacls.exe", args: [plan.resources.dataDir, "/grant", "NT AUTHORITY\\LocalService:(OI)(CI)(M)"], description: "data", idempotency: "repeatable" },
    { command: "sc.exe", args: ["create", "CarMediaHubCore", "binPath= \\\"C:\\Program Files\\CarMediaHub\\node.exe\\\" \\\"C:\\Program Files\\CarMediaHub\\dist\\cli.js\\\"", "start= auto", "DisplayName= CarMediaHub Core", "obj= \"NT AUTHORITY\\LocalService\""], description: "create", idempotency: "ensure" },
    { command: "sc.exe", args: ["description", "CarMediaHubCore", "Core"], description: "description", idempotency: "repeatable" },
    { command: "sc.exe", args: ["start", "CarMediaHubCore"], description: "start", idempotency: "repeatable" },
  ];
  const result = verifyNativeInstallPlan(plan, { run: (_executable, args) => args[0] === "qc" ? { status: 0, stdout: "BINARY_PATH_NAME   : \\\"C:\\Program Files\\CarMediaHub\\node.exe\\\" \\\"C:\\Program Files\\CarMediaHub\\dist\\cli.js\\\"\nSERVICE_START_NAME : NT AUTHORITY\\LocalService", stderr: "" } : { status: 0, stdout: "STATE              : 4  RUNNING", stderr: "" } });
  assert.equal(result.verified, true);
});

test("CLI returns nonzero for a plan that is not installed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-install-verify-"));
  const planPath = path.join(root, "plan.json");
  fs.writeFileSync(planPath, JSON.stringify(linuxPlan));
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "native-install-verify.mjs");
  assert.throws(() => execFileSync(process.execPath, [script, "--plan", planPath], { encoding: "utf8", stdio: "pipe" }), /Native install verification failed|is not installed/u);
  fs.rmSync(root, { recursive: true, force: true });
});
