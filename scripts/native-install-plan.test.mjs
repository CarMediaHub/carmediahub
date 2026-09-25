import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createNativeInstallPlan } from "./native-install-plan.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-install-plan-"));
  const bundleRoot = path.join(root, "bundle"); const configPath = path.join(root, "config", "core.json"); const dataDir = path.join(root, "data");
  for (const relative of ["dist/cli.js", "public/admin/index.html", "scripts/upgrade-preflight.mjs", "scripts/native-install-plan.mjs", "scripts/native-install-actions.mjs", "scripts/native-windows-service.mjs", "scripts/native-linux-service.mjs", "scripts/validate-native-bundle.mjs", "config/components.json", "config/components.schema.json", "config/component-release.schema.json", "config/component-release-matrix.schema.json", "config/core.schema.json", "config/core.example.json", "node_modules/fastify/package.json", "node_modules/@fastify/cookie/package.json", "node_modules/pg/package.json", "node_modules/@carmediahub/sdk/package.json", "node_modules/@carmediahub/sdk/dist/index.js"]) { const location = path.join(bundleRoot, relative); fs.mkdirSync(path.dirname(location), { recursive: true }); fs.writeFileSync(location, "{}\n"); }
  fs.writeFileSync(path.join(bundleRoot, "package.json"), JSON.stringify({ type: "module", private: true, version: "0.1.0", carmediahub: { databaseSchemaVersion: 1 } })); fs.mkdirSync(path.dirname(configPath), { recursive: true }); fs.writeFileSync(configPath, "{}\n"); fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(bundleRoot, "config/native-install-plan.schema.json"), "{}\n");
  return { bundleRoot, configPath, dataDir };
}
const common = (input) => ({ ...input, nodePath: process.platform === "win32" ? "C:/CMH/runtime/node.exe" : "/opt/cmh/runtime/node", serviceName: process.platform === "win32" ? "CarMediaHubCore" : "carmediahub-core", description: "CarMediaHub Core", requiredFreeBytes: 1 });

test("emits the versioned native plan contract", () => { const input = fixture(); const plan = createNativeInstallPlan({ ...common(input), platform: "linux", nodePath: "/opt/cmh/runtime/node", serviceName: "carmediahub-core" }, { checkResources: () => ({ bundleRoot: "/opt/carmediahub", configPath: "/etc/carmediahub/core.json", dataDir: "/var/lib/carmediahub", freeBytes: 4096, requiredFreeBytes: 1 }) }); assert.equal(plan.schemaVersion, 1); });

test("creates a Windows install plan without executing service registration", () => { const input = fixture(); const plan = createNativeInstallPlan({ ...common(input), platform: "windows" }, { statfs: () => ({ bavail: 4, bsize: 1024 }) }); assert.equal(plan.platform, "windows"); assert.equal(plan.bundle.databaseSchemaVersion, 1); assert.equal(plan.serviceAccount, "NT AUTHORITY\\LocalService"); assert.deepEqual(plan.acl.map((entry) => entry.access), ["read-execute", "read-only", "read-write"]); assert.match(plan.service.command, /dist\\cli\.js/iu); assert.equal(plan.resources.freeBytes, 4096); });
test("creates a Linux install plan with hardened unit text", () => { const input = fixture(); const plan = createNativeInstallPlan({ ...common(input), platform: "linux", nodePath: "/opt/cmh/runtime/node", serviceName: "carmediahub-core" }, { checkResources: () => ({ bundleRoot: "/opt/carmediahub", configPath: "/etc/carmediahub/core.json", dataDir: "/var/lib/carmediahub", freeBytes: 4096, requiredFreeBytes: 1 }) }); assert.equal(plan.serviceAccount, "carmediahub"); assert.match(plan.service.unitText, /NoNewPrivileges=true/iu); assert.match(plan.service.unitText, /ReadWritePaths/iu); });
test("rejects unsupported platforms and insufficient resources", () => { const input = fixture(); assert.throws(() => createNativeInstallPlan({ ...common(input), platform: "macos" }, { statfs: () => ({ bavail: 4, bsize: 1024 }) }), /platform/); assert.throws(() => createNativeInstallPlan({ ...common(input), platform: "linux", nodePath: "/opt/node", serviceName: "carmediahub-core", requiredFreeBytes: 4097 }, { statfs: () => ({ bavail: 4, bsize: 1024 }) }), /insufficient free space/); });
test("rejects unsafe Linux service accounts", () => { const input = fixture(); assert.throws(() => createNativeInstallPlan({ ...common(input), platform: "linux", serviceAccount: "root;rm" }, { statfs: () => ({ bavail: 4, bsize: 1024 }) }), /serviceAccount/); });
test("rejects unsafe Windows service accounts", () => { const input = fixture(); assert.throws(() => createNativeInstallPlan({ ...common(input), platform: "windows", serviceAccount: "DOMAIN\\\\User;bad" }, { statfs: () => ({ bavail: 4, bsize: 1024 }) }), /serviceAccount/); });
