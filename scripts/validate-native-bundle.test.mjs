import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateNativeBundle } from "./validate-native-bundle.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-native-bundle-"));
  for (const relative of ["dist/cli.js", "public/admin/index.html", "config/components.json", "config/components.schema.json", "config/core.schema.json", "config/core.example.json"]) {
    const location = path.join(root, relative); fs.mkdirSync(path.dirname(location), { recursive: true }); fs.writeFileSync(location, "{}\n");
  }
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module", private: true, version: "0.1.0" }));
  return root;
}

test("accepts a complete native bundle without instance configuration", () => {
  assert.deepEqual(validateNativeBundle(fixture()), { files: 7, packageVersion: "0.1.0" });
});

test("rejects missing runtime assets and instance secrets", () => {
  const root = fixture();
  fs.rmSync(path.join(root, "dist/cli.js"));
  assert.throws(() => validateNativeBundle(root), /missing file/);
  fs.writeFileSync(path.join(root, "dist/cli.js"), "// cli\n");
  fs.writeFileSync(path.join(root, "config/core.json"), "{}\n");
  assert.throws(() => validateNativeBundle(root), /instance secret/);
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
