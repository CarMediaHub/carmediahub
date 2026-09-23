import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadBrowserTargetRegistry } from "./browser-target-config.js";

test("loads deployment-owned HTTPS browser targets without environment discovery", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-browser-targets-"));
  try {
    fs.writeFileSync(path.join(dataDir, "browser-targets.json"), JSON.stringify({ schemaVersion: 1, targets: [{ id: "fixture", origins: ["https://fixture.example"] }] }));
    const registry = loadBrowserTargetRegistry(dataDir);
    assert.deepEqual(registry.ids(), ["fixture"]);
    assert.equal(registry.get("fixture")?.origins[0], "https://fixture.example");
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("rejects malformed or unsafe deployment browser targets", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-browser-targets-invalid-"));
  try {
    fs.writeFileSync(path.join(dataDir, "browser-targets.json"), JSON.stringify({ schemaVersion: 2, targets: [] }));
    assert.throws(() => loadBrowserTargetRegistry(dataDir), /Invalid browser target configuration/);
    fs.writeFileSync(path.join(dataDir, "browser-targets.json"), JSON.stringify({ schemaVersion: 1, targets: [{ id: "unsafe", origins: ["http://localhost"] }] }));
    assert.throws(() => loadBrowserTargetRegistry(dataDir), /origin is invalid/);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});
