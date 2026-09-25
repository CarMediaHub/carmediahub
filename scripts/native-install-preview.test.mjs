import assert from "node:assert/strict";
import test from "node:test";
import { createNativeInstallActions } from "./native-install-actions.mjs";
import { previewNativeInstallPlan } from "./native-install-preview.mjs";

const plan = {
  schemaVersion: 1,
  bundle: { files: 20, packageVersion: "0.1.0", databaseSchemaVersion: 1 },
  resources: { bundleRoot: "/opt/carmediahub", configPath: "/etc/carmediahub/core.json", dataDir: "/var/lib/carmediahub", freeBytes: 4096, requiredFreeBytes: 1 },
  serviceAccount: "carmediahub",
  acl: [{ path: "/var/lib/carmediahub", access: "read-write" }],
  service: { serviceName: "carmediahub-core", unitName: "carmediahub-core.service", unitText: "[Unit]\nDescription=CarMediaHub Core\n" },
  platform: "linux",
  actions: createNativeInstallActions({
    platform: "linux",
    serviceAccount: "carmediahub",
    resources: { bundleRoot: "/opt/carmediahub", configPath: "/etc/carmediahub/core.json", dataDir: "/var/lib/carmediahub" },
    service: { serviceName: "carmediahub-core", unitName: "carmediahub-core.service", unitText: "[Unit]\nDescription=CarMediaHub Core\n" },
  }),
};

test("previews a serialized plan without applying system actions", () => {
  const result = previewNativeInstallPlan(JSON.parse(JSON.stringify(plan)));
  assert.equal(result.applied, false);
  assert.equal(result.actions.length, 7);
  assert.equal(result.actions.every((item) => item.applied === false), true);
});

test("rejects an invalid serialized action plan", () => {
  assert.throws(() => previewNativeInstallPlan({ ...plan, actions: [{ command: "sh", args: [], description: "bad", idempotency: "repeatable" }] }), /command is not allowed/);
});

test("rejects a plan that is missing its versioned contract fields", () => {
  assert.throws(() => previewNativeInstallPlan({ platform: "linux", actions: [] }), /schemaVersion/);
  assert.throws(() => previewNativeInstallPlan({ ...plan, schemaVersion: 2 }), /schemaVersion/);
  assert.throws(() => previewNativeInstallPlan({ ...plan, resources: undefined }), /resources/);
});
