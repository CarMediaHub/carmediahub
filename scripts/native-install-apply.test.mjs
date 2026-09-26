import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { applyNativeInstallPlan, assertWindowsAdministrator } from "./native-install-apply.mjs";
import { createNativeInstallActions } from "./native-install-actions.mjs";

const plan = {
  schemaVersion: 1,
  platform: "linux",
  bundle: { files: 1 },
  resources: { bundleRoot: "/opt/cmh", configPath: "/etc/cmh/core.json", dataDir: "/var/lib/cmh" },
  service: { serviceName: "cmh", unitName: "cmh.service" },
  serviceAccount: "cmh_test",
  acl: [{ path: "/opt/cmh" }, { path: "/etc/cmh/core.json" }, { path: "/var/lib/cmh" }],
  actions: [
    { command: "useradd", args: ["--system", "--no-create-home", "--shell", "/usr/sbin/nologin", "cmh_test"], description: "create account if absent", idempotency: "ensure" },
    { command: "install", args: ["-d", "-o", "cmh_test", "-g", "cmh_test", "-m", "0750", "/var/lib/cmh"], description: "create data", idempotency: "repeatable" },
    { command: "install", args: ["-d", "-o", "root", "-g", "root", "-m", "0755", "/etc/cmh"], description: "create config", idempotency: "repeatable" },
    { command: "install", args: ["-m", "0644", "--owner=root", "--group=root", "/dev/stdin", "/etc/systemd/system/cmh.service"], description: "write unit", stdin: "[Unit]\n", idempotency: "repeatable" },
    { command: "chown", args: ["-R", "cmh_test:cmh_test", "/var/lib/cmh"], description: "set ownership", idempotency: "repeatable" },
    { command: "systemctl", args: ["daemon-reload"], description: "reload units", idempotency: "repeatable" },
    { command: "systemctl", args: ["enable", "--now", "cmh.service"], description: "start service", idempotency: "repeatable" },
  ],
};

const windowsPlan = (() => {
  const resources = {
    bundleRoot: "C:/Program Files/CarMediaHub",
    configPath: "C:/ProgramData/CarMediaHub/core.json",
    dataDir: "C:/ProgramData/CarMediaHub/data",
  };
  const service = {
    serviceName: "CarMediaHubCore",
    createArguments: [
      "create",
      "CarMediaHubCore",
      "binPath= C:\\Program Files\\CarMediaHub\\node.exe",
      "start= auto",
      "DisplayName= CarMediaHub Core",
      "obj= \"NT AUTHORITY\\LocalService\"",
    ],
    descriptionArguments: ["description", "CarMediaHubCore", "CarMediaHub Core"],
  };
  return {
    schemaVersion: 1,
    platform: "windows",
    bundle: { files: 1 },
    resources,
    service,
    serviceAccount: "NT AUTHORITY\\LocalService",
    acl: [
      { path: resources.bundleRoot, access: "read-execute" },
      { path: resources.configPath, access: "read-only" },
      { path: resources.dataDir, access: "read-write" },
    ],
    actions: createNativeInstallActions({ platform: "windows", resources, service, serviceAccount: "NT AUTHORITY\\LocalService" }),
  };
})();

test("previews a plan by default and never invokes an action", () => {
  let called = false;
  const result = applyNativeInstallPlan(plan, { execute: () => { called = true; } });
  assert.equal(result.applied, false);
  assert.equal(called, false);
  assert.equal(result.actions.length, 7);
});

test("requires a separate confirmation for actual application", () => {
  assert.throws(() => applyNativeInstallPlan(plan, { apply: true }), /CARMEDIAHUB_APPLY/u);
});

test("requires elevated Windows privileges before applying", () => {
  assert.equal(assertWindowsAdministrator({ probe: () => ({ status: 0 }) }), true);
  assert.throws(() => assertWindowsAdministrator({ probe: () => ({ status: 1 }) }), /elevated administrator/u);
});

test("rejects a non-elevated Windows apply before executing ACL or service actions", () => {
  let executed = 0;
  assert.throws(
    () => applyNativeInstallPlan(windowsPlan, {
      apply: true,
      confirm: "CARMEDIAHUB_APPLY",
      windowsPrivilegeProbe: () => ({ status: 1 }),
      execute: () => { executed += 1; throw new Error("must not execute"); },
    }),
    /elevated administrator/u,
  );
  assert.equal(executed, 0);
});

test("rejects an action list without a complete Core plan envelope", () => {
  const incomplete = { schemaVersion: 1, platform: "linux", actions: plan.actions };
  assert.throws(() => applyNativeInstallPlan(incomplete), /plan is missing bundle/u);
});

test("applies only after explicit confirmation and ensure inspection", () => {
  const calls = [];
  const result = applyNativeInstallPlan(plan, { apply: true, confirm: "CARMEDIAHUB_APPLY", inspectEnsure: () => "missing", execute: (executable, args) => { calls.push({ executable, args }); return { status: 0, stdout: "", stderr: "" }; } });
  assert.equal(result.applied, true);
  assert.equal(calls.length, 7);
  assert.equal(calls.at(-1).args.join(" "), "enable --now cmh.service");
});

test("CLI never enters apply mode without the confirmation phrase", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-install-apply-"));
  const planPath = path.join(root, "plan.json");
  fs.writeFileSync(planPath, JSON.stringify(plan));
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "native-install-apply.mjs");
  assert.throws(() => execFileSync(process.execPath, [script, "--plan", planPath, "--apply"], { encoding: "utf8", stdio: "pipe" }), /usage: native-install-apply/u);
  const preview = JSON.parse(execFileSync(process.execPath, [script, "--plan", planPath], { encoding: "utf8" }));
  assert.equal(preview.applied, false);
});

test("treats a matching Linux account as idempotent", () => {
  const calls = [];
  const result = applyNativeInstallPlan(plan, { apply: true, confirm: "CARMEDIAHUB_APPLY", inspectEnsure: () => "matching", execute: (executable, args) => { calls.push({ executable, args }); return { status: 0, stdout: "", stderr: "" }; } });
  assert.equal(result.actions[0].skipped, true);
  assert.equal(calls.length, 6);
});
