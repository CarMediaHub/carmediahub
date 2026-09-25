import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { applyNativeInstallPlan } from "./native-install-apply.mjs";

const plan = {
  schemaVersion: 1,
  platform: "linux",
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
