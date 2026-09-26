import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { executeNativeInstallActions, NativeInstallExecutionError } from "./native-install-executor.mjs";
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

test("stages Linux unit stdin for Node process execution", () => {
  let staged;
  executeNativeInstallActions(linuxActions, "linux", {
    apply: true,
    inspectEnsure: () => "matching",
    execute: (executable, args, stdin) => {
      if (executable === "/usr/bin/install" && args.includes("/etc/systemd/system/carmediahub-core.service")) {
        const source = args.find((value) => value.includes("carmediahub-native-"));
        staged = { args, stdin, source, content: source === undefined ? undefined : fs.readFileSync(source, "utf8") };
      }
      return { status: 0 };
    },
  });
  assert.equal(staged?.stdin, undefined);
  assert.equal(typeof staged?.source, "string");
  assert.equal(staged?.content, linuxActions[3]?.stdin);
  assert.equal(fs.existsSync(staged?.source ?? ""), false);
});

test("rejects an ensure target whose existing properties differ", () => {
  assert.throws(() => executeNativeInstallActions(linuxActions, "linux", { apply: true, inspectEnsure: () => "mismatch", execute: () => ({ status: 0 }) }), /does not match/);
});

test("rejects relative command path overrides", () => {
  assert.throws(() => executeNativeInstallActions(linuxActions, "linux", { commandPaths: { useradd: "useradd" } }), /must be absolute/);
});

test("reports partial application without claiming installation succeeded", () => {
  const calls = [];
  assert.throws(() => executeNativeInstallActions(linuxActions, "linux", {
    apply: true,
    inspectEnsure: () => "missing",
    execute: (executable, args) => {
      calls.push({ executable, args });
      if (calls.length === 2) throw new Error("simulated install failure");
      return { status: 0 };
    },
  }), (error) => {
    assert.equal(error instanceof NativeInstallExecutionError, true);
    assert.equal(error.platform, "linux");
    assert.equal(error.failedActionIndex, 1);
    assert.equal(error.appliedActions.length, 1);
    assert.equal(error.appliedActions[0].command, "useradd");
    return true;
  });
});

test("runs explicitly enabled compensation in reverse order and records completion", () => {
  const calls = [];
  assert.throws(() => executeNativeInstallActions(linuxActions, "linux", {
    apply: true,
    inspectEnsure: () => "missing",
    execute: (executable, args) => {
      if (args.at(-1) === "/etc/carmediahub") throw new Error("simulated install failure");
      return { status: 0 };
    },
    compensateOnFailure: true,
    compensate: (applied) => {
      calls.push(applied.command);
      return { status: "reverted-by-platform-adapter" };
    },
  }), (error) => {
    assert.equal(error instanceof NativeInstallExecutionError, true);
    assert.deepEqual(calls, ["install", "useradd"]);
    assert.equal(error.compensation?.attempted, true);
    assert.equal(error.compensation?.status, "completed");
    assert.equal(error.compensation?.results.length, 2);
    return true;
  });
});

test("never attempts compensation implicitly", () => {
  let called = false;
  assert.throws(() => executeNativeInstallActions(linuxActions, "linux", {
    apply: true,
    inspectEnsure: () => "missing",
    execute: (executable, args) => {
      if (args.at(-1) === "/etc/carmediahub") throw new Error("simulated install failure");
      return { status: 0 };
    },
    compensate: () => { called = true; },
  }), (error) => {
    assert.equal(error.compensation, undefined);
    assert.equal(called, false);
    return true;
  });
});

test("reports a missing handler when compensation is explicitly requested", () => {
  assert.throws(() => executeNativeInstallActions(linuxActions, "linux", {
    apply: true,
    inspectEnsure: () => "missing",
    execute: (executable, args) => {
      if (args.at(-1) === "/etc/carmediahub") throw new Error("simulated install failure");
      return { status: 0 };
    },
    compensateOnFailure: true,
  }), (error) => {
    assert.equal(error.compensation?.status, "handler-missing");
    assert.equal(error.appliedActions.length, 2);
    return true;
  });
});
