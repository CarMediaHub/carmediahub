import assert from "node:assert/strict";
import test from "node:test";
import { createNativeInstallActions } from "./native-install-actions.mjs";

const base = (platform) => ({
  platform,
  serviceAccount: platform === "linux" ? "carmediahub" : "NT AUTHORITY\\LocalService",
  resources: platform === "linux"
    ? { bundleRoot: "/opt/carmediahub", configPath: "/etc/carmediahub/core.json", dataDir: "/var/lib/carmediahub" }
    : { bundleRoot: "C:/Program Files/CarMediaHub", configPath: "C:/ProgramData/CarMediaHub/core.json", dataDir: "C:/ProgramData/CarMediaHub/data" },
  service: platform === "linux"
    ? { serviceName: "carmediahub-core", unitName: "carmediahub-core.service" }
    : { serviceName: "CarMediaHubCore", createArguments: ["create", "CarMediaHubCore"], descriptionArguments: ["description", "CarMediaHubCore", "CarMediaHub Core"] },
});

test("creates Windows ACL and service actions without executing them", () => {
  const actions = createNativeInstallActions(base("windows"));
  assert.deepEqual(actions.map((item) => item.command), ["icacls.exe", "icacls.exe", "icacls.exe", "sc.exe", "sc.exe", "sc.exe"]);
  assert.deepEqual(actions.at(-1)?.args, ["start", "CarMediaHubCore"]);
});

test("creates Linux account, filesystem, and systemd actions", () => {
  const actions = createNativeInstallActions(base("linux"));
  assert.deepEqual(actions.map((item) => item.command), ["useradd", "install", "install", "install", "chown", "systemctl", "systemctl"]);
  assert.deepEqual(actions.at(-1)?.args, ["enable", "--now", "carmediahub-core.service"]);
});

test("rejects unsafe action plan paths and accounts", () => {
  assert.throws(() => createNativeInstallActions({ ...base("linux"), serviceAccount: "root;rm" }), /serviceAccount/);
  assert.throws(() => createNativeInstallActions({ ...base("windows"), resources: { ...base("windows").resources, dataDir: "relative" } }), /absolute/);
});
