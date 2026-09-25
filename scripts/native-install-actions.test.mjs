import assert from "node:assert/strict";
import test from "node:test";
import { createNativeInstallActions, validateNativeInstallActions } from "./native-install-actions.mjs";

const base = (platform) => ({
  platform,
  serviceAccount: platform === "linux" ? "carmediahub" : "NT AUTHORITY\\LocalService",
  resources: platform === "linux"
    ? { bundleRoot: "/opt/carmediahub", configPath: "/etc/carmediahub/core.json", dataDir: "/var/lib/carmediahub" }
    : { bundleRoot: "C:/Program Files/CarMediaHub", configPath: "C:/ProgramData/CarMediaHub/core.json", dataDir: "C:/ProgramData/CarMediaHub/data" },
  service: platform === "linux"
    ? { serviceName: "carmediahub-core", unitName: "carmediahub-core.service", unitText: "[Unit]\nDescription=CarMediaHub Core\n" }
    : { serviceName: "CarMediaHubCore", createArguments: ["create", "CarMediaHubCore"], descriptionArguments: ["description", "CarMediaHubCore", "CarMediaHub Core"] },
});

test("creates Windows ACL and service actions without executing them", () => {
  const actions = createNativeInstallActions(base("windows"));
  assert.deepEqual(actions.map((item) => item.command), ["icacls.exe", "icacls.exe", "icacls.exe", "sc.exe", "sc.exe", "sc.exe"]);
  assert.deepEqual(actions.slice(0, 3).map((item) => item.args.slice(-2)), [
    ["/grant", "NT AUTHORITY\\LocalService:(OI)(CI)(RX)"],
    ["/grant", "NT AUTHORITY\\LocalService:(R)"],
    ["/grant", "NT AUTHORITY\\LocalService:(OI)(CI)(M)"],
  ]);
  assert.equal(actions[3]?.idempotency, "ensure");
  assert.equal(actions[4]?.idempotency, "repeatable");
  assert.deepEqual(actions.at(-1)?.args, ["start", "CarMediaHubCore"]);
});

test("creates Linux account, filesystem, and systemd actions", () => {
  const actions = createNativeInstallActions(base("linux"));
  assert.deepEqual(actions.map((item) => item.command), ["useradd", "install", "install", "install", "chown", "systemctl", "systemctl"]);
  const unitAction = actions[3];
  assert.deepEqual(unitAction?.args.slice(-2), ["/dev/stdin", "/etc/systemd/system/carmediahub-core.service"]);
  assert.match(unitAction?.stdin ?? "", /^\[Unit\]/u);
  assert.equal(unitAction?.args.includes("<generated-unit-text>"), false);
  assert.equal(actions[0]?.idempotency, "ensure");
  assert.equal(actions[1]?.idempotency, "repeatable");
  assert.deepEqual(actions.at(-1)?.args, ["enable", "--now", "carmediahub-core.service"]);
});

test("rejects unsafe action plan paths and accounts", () => {
  assert.throws(() => createNativeInstallActions({ ...base("linux"), serviceAccount: "root;rm" }), /serviceAccount/);
  assert.throws(() => createNativeInstallActions({ ...base("windows"), resources: { ...base("windows").resources, dataDir: "relative" } }), /absolute/);
  assert.throws(() => createNativeInstallActions({ ...base("linux"), service: { ...base("linux").service, unitText: "" } }), /systemd unit text/);
  assert.throws(() => createNativeInstallActions({ ...base("windows"), serviceAccount: "DOMAIN\\\\User;bad" }), /serviceAccount/);
});

test("validates serialized actions before a privileged executor consumes them", () => {
  const actions = createNativeInstallActions(base("linux"));
  assert.equal(validateNativeInstallActions(JSON.parse(JSON.stringify(actions)), "linux").length, 7);
  assert.throws(() => validateNativeInstallActions([{ ...actions[0], command: "sh" }], "linux"), /command is not allowed/);
  assert.throws(() => validateNativeInstallActions([{ ...actions[0], args: ["--bad\n"] }], "linux"), /arguments are invalid/);
  assert.throws(() => validateNativeInstallActions([{ ...actions[0], idempotency: "ignore" }], "linux"), /idempotency is invalid/);
  assert.throws(() => validateNativeInstallActions([{ ...actions[0], stdin: "unexpected" }], "linux"), /stdin is not allowed/);
});

test("rejects incomplete, duplicated, or reordered platform action stages", () => {
  const windows = createNativeInstallActions(base("windows"));
  const linux = createNativeInstallActions(base("linux"));

  assert.throws(() => validateNativeInstallActions(windows.slice(0, -1), "windows"), /exactly 6 actions/);
  assert.throws(() => validateNativeInstallActions([...windows, windows.at(-1)], "windows"), /exactly 6 actions/);

  const reorderedWindows = [...windows];
  [reorderedWindows[0], reorderedWindows[3]] = [reorderedWindows[3], reorderedWindows[0]];
  assert.throws(() => validateNativeInstallActions(reorderedWindows, "windows"), /action 0 must be icacls\.exe/);

  const reorderedLinux = [...linux];
  [reorderedLinux[3], reorderedLinux[5]] = [reorderedLinux[5], reorderedLinux[3]];
  assert.throws(() => validateNativeInstallActions(reorderedLinux, "linux"), /action 3 must be install/);
});
