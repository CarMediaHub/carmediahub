import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createNativeBundle } from "./create-native-bundle.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-native-source-"));
  for (const relative of ["dist/cli.js", "public/admin/index.html", "scripts/upgrade-preflight.mjs", "scripts/native-install-plan.mjs", "scripts/native-install-actions.mjs", "scripts/native-windows-service.mjs", "scripts/native-linux-service.mjs", "scripts/validate-native-bundle.mjs", "config/components.json", "config/components.schema.json", "config/component-release.schema.json", "config/core.schema.json", "config/core.example.json", "node_modules/@carmediahub/sdk/dist/index.js"]) {
    const location = path.join(root, relative); fs.mkdirSync(path.dirname(location), { recursive: true }); fs.writeFileSync(location, "{}\n");
  }
  fs.writeFileSync(path.join(root, "config/native-install-plan.schema.json"), "{}\n");
  for (const relative of ["node_modules/@carmediahub/sdk/package.json", "node_modules/fastify/package.json", "node_modules/@fastify/cookie/package.json", "node_modules/pg/package.json"]) {
    const location = path.join(root, relative); fs.mkdirSync(path.dirname(location), { recursive: true }); fs.writeFileSync(location, "{}\n");
  }
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module", private: true, version: "0.1.0", carmediahub: { databaseSchemaVersion: 1 } }));
  fs.writeFileSync(path.join(root, "config/core.json"), "{}\n");
  return root;
}

test("creates a validated bundle without instance configuration", () => {
  const source = fixture();
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-native-output-"));
  const result = createNativeBundle(source, path.join(output, "bundle"));
  assert.deepEqual(result, { files: 20, packageVersion: "0.1.0", databaseSchemaVersion: 1 });
  assert.equal(fs.existsSync(path.join(output, "bundle/config/core.json")), false);
});

test("rejects an output inside the source tree", () => {
  const source = fixture();
  assert.throws(() => createNativeBundle(source, path.join(source, "bundle")), /output must be outside/);
});
