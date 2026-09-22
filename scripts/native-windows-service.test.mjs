import assert from "node:assert/strict";
import test from "node:test";
import { createWindowsServiceSpec } from "./native-windows-service.mjs";

const valid = { serviceName: "CarMediaHubCore", displayName: "CarMediaHub Core", description: "CarMediaHub Core service", nodePath: "C:/CarMediaHub/runtime/node.exe", bundleRoot: "C:/CarMediaHub", dataDir: "C:/ProgramData/CarMediaHub", configPath: "C:/ProgramData/CarMediaHub/core.json" };

test("creates an explicit sc.exe service specification", () => {
  const spec = createWindowsServiceSpec(valid);
  assert.equal(spec.serviceName, "CarMediaHubCore");
  assert.match(spec.command, /node\.exe.*dist\\cli\.js.*--config/iu);
  assert.match(spec.command, /--data-dir/iu);
  assert.deepEqual(spec.createArguments.slice(0, 2), ["create", "CarMediaHubCore"]);
  assert.equal(spec.descriptionArguments[0], "description");
  assert.equal(spec.serviceAccount, "NT AUTHORITY\\LocalService");
  assert.match(spec.createArguments.at(-1), /LocalService/u);
  const rootSpec = createWindowsServiceSpec({ ...valid, bundleRoot: "C:\\" });
  assert.match(rootSpec.command, /C:\\dist\\cli\.js/iu);
});

test("rejects unsafe service metadata and implicit paths", () => {
  assert.throws(() => createWindowsServiceSpec({ ...valid, serviceName: "bad name" }), /serviceName/);
  assert.throws(() => createWindowsServiceSpec({ ...valid, nodePath: "node.exe" }), /nodePath.*absolute Windows/);
  assert.throws(() => createWindowsServiceSpec({ ...valid, configPath: "C:/secret\".json" }), /configPath/);
  assert.throws(() => createWindowsServiceSpec({ ...valid, description: "line\ncontaining" }), /description/);
});
