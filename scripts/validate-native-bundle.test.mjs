import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateNativeBundle } from "./validate-native-bundle.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-native-bundle-"));
  for (const relative of ["dist/cli.js", "public/admin/index.html", "scripts/upgrade-preflight.mjs", "scripts/validate-native-bundle.mjs", "config/components.json", "config/components.schema.json", "config/core.schema.json", "config/core.example.json", "node_modules/fastify/package.json", "node_modules/@fastify/cookie/package.json", "node_modules/pg/package.json", "node_modules/@carmediahub/sdk/package.json", "node_modules/@carmediahub/sdk/dist/index.js"]) {
    const location = path.join(root, relative); fs.mkdirSync(path.dirname(location), { recursive: true }); fs.writeFileSync(location, "{}\n");
  }
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module", private: true, version: "0.1.0", carmediahub: { databaseSchemaVersion: 1 } }));
  return root;
}

test("accepts a complete native bundle without instance configuration", () => {
  assert.deepEqual(validateNativeBundle(fixture()), { files: 14, packageVersion: "0.1.0", databaseSchemaVersion: 1 });
});

test("rejects missing runtime assets and instance secrets", () => {
  const root = fixture();
  fs.rmSync(path.join(root, "dist/cli.js"));
  assert.throws(() => validateNativeBundle(root), /missing file/);
  fs.writeFileSync(path.join(root, "dist/cli.js"), "// cli\n");
  fs.writeFileSync(path.join(root, "config/core.json"), "{}\n");
  assert.throws(() => validateNativeBundle(root), /instance secret/);
});

test("rejects a bundle with missing runtime dependencies", () => {
  const root = fixture();
  fs.rmSync(path.join(root, "node_modules/pg/package.json"));
  assert.throws(() => validateNativeBundle(root), /node_modules[\\/]pg[\\/]package\.json/);
});

test("rejects a symlinked runtime dependency in strict bundle mode", (t) => {
  const root = fixture();
  const target = path.join(root, "outside-sdk");
  fs.mkdirSync(target, { recursive: true });
  fs.rmSync(path.join(root, "node_modules/@carmediahub/sdk"), { recursive: true, force: true });
  try {
    fs.symlinkSync(target, path.join(root, "node_modules/@carmediahub/sdk"), "junction");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) { t.skip("junctions are unavailable in this environment"); return; }
    throw error;
  }
  assert.throws(() => validateNativeBundle(root), /symbolic link/);
});

test("rejects a symlinked release asset", (t) => {
  const root = fixture();
  const target = path.join(root, "outside.json");
  fs.writeFileSync(target, "{}\n");
  fs.rmSync(path.join(root, "config/core.example.json"));
  try {
    fs.symlinkSync(target, path.join(root, "config/core.example.json"), "file");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) { t.skip("symbolic links are unavailable in this environment"); return; }
    throw error;
  }
  assert.throws(() => validateNativeBundle(root), /symbolic link/);
});

test("rejects a symbolic bundle root", (t) => {
  const realRoot = fixture();
  const linkRoot = `${realRoot}-link`;
  try {
    fs.symlinkSync(realRoot, linkRoot, "junction");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) { t.skip("junctions are unavailable in this environment"); return; }
    throw error;
  }
  assert.throws(() => validateNativeBundle(linkRoot), /symbolic/);
});
