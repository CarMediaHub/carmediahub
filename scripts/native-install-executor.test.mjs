import assert from "node:assert/strict";
import test from "node:test";
import { executeNativeInstallActions } from "./native-install-executor.mjs";
import { createNativeInstallActions } from "./native-install-actions.mjs";

const linuxActions = createNativeInstallActions({
  platform: "linux",
  serviceAccount: "carmediahub",
  resources: { bundleRoot: "/opt/carmediahub", configPath: "/etc/carmediahub/core.json", dataDir: "/var/lib/carmediahub" },
  service: { serviceName: "carmediahub-core", unitName: "carmediahub-core.service", unitText: "[Unit]\nDescription=CarMediaHub Core\n" },
});

test("previews validated actions with explicit executable paths", () => {
  const result = executeNativeInstallActions(linuxActions, "linux");
  assert.equal(result.applied, false);
  assert.equal(result.actions[0]?.executable, "/usr/sbin/useradd");
  assert.equal(result.actions[1]?.executable, "/usr/bin/install");
});

test("requires an ensure inspection before applying privileged actions", () => {
  assert.throws(() => executeNativeInstallActions(linuxActions, "linux", { apply: true, execute: () => ({ status: 0 }) }), /ensure inspection/);
});

test("skips matching ensure targets and executes missing actions without a shell", () => {
  const calls = [];
  const result = executeNativeInstallActions(linuxActions, "linux", {
    apply: true,
    inspectEnsure: () => "matching",
    execute: (executable, args, stdin) => { calls.push({ executable, args, stdin }); return { status: 0 }; },
  });
  assert.equal(result.actions[0]?.skipped, true);
  assert.equal(calls.length, 6);
  assert.equal(calls[0]?.executable, "/usr/bin/install");
});

test("rejects an ensure target whose existing properties differ", () => {
  assert.throws(() => executeNativeInstallActions(linuxActions, "linux", { apply: true, inspectEnsure: () => "mismatch", execute: () => ({ status: 0 }) }), /does not match/);
});

test("rejects relative command path overrides", () => {
  assert.throws(() => executeNativeInstallActions(linuxActions, "linux", { commandPaths: { useradd: "useradd" } }), /must be absolute/);
});
