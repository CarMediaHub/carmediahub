import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runManagedComponent } from "./managed-component-runner.js";

function fixture(): { dataDir: string; component: { id: string; version: string; executable: string } } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-component-runner-"));
  const location = path.join(dataDir, "components", "fixture", "1.0.0");
  fs.mkdirSync(location, { recursive: true });
  const executable = process.platform === "win32" ? "node.exe" : "node";
  fs.copyFileSync(process.execPath, path.join(location, executable));
  const executablePath = path.join(location, executable);
  const checksum = crypto.createHash("sha256").update(fs.readFileSync(executablePath)).digest("hex");
  return { dataDir, component: { id: "fixture", version: "1.0.0", executable: `fixture/1.0.0/${executable}`, checksum } };
}

test("runs a verified component with an explicit empty environment", async () => {
  const { dataDir, component } = fixture();
  try {
    const result = await runManagedComponent(dataDir, component, { args: ["-e", "process.stdout.write(process.env.CMH_TEST_SECRET === undefined ? 'no-secret' : process.env.CMH_TEST_SECRET)"] });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "no-secret");
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("rejects unsafe identities, arguments and unavailable files", async () => {
  const { dataDir, component } = fixture();
  try {
    await assert.rejects(runManagedComponent(dataDir, { ...component, id: "../escape" }), (error: unknown) => (error as { code?: string }).code === "CMH.COMPONENT.IDENTITY_INVALID");
    await assert.rejects(runManagedComponent(dataDir, component, { args: ["bad\0arg"] }), (error: unknown) => (error as { code?: string }).code === "CMH.COMPONENT.ARGUMENTS_INVALID");
    await assert.rejects(runManagedComponent(dataDir, { ...component, executable: "fixture/1.0.0/missing" }), (error: unknown) => (error as { code?: string }).code === "CMH.COMPONENT.EXECUTABLE_UNAVAILABLE");
    fs.appendFileSync(path.join(dataDir, "components", "fixture", "1.0.0", path.basename(component.executable)), "tampered");
    await assert.rejects(runManagedComponent(dataDir, component), (error: unknown) => (error as { code?: string }).code === "CMH.COMPONENT.DIGEST_MISMATCH");
    await assert.rejects(runManagedComponent(dataDir, { ...component, executable: "fixture/1.0.0/missing", checksum: component.checksum }), (error: unknown) => (error as { code?: string }).code === "CMH.COMPONENT.EXECUTABLE_UNAVAILABLE" && !String(error).includes(dataDir));
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("rejects a component installation without a required role", async () => {
  const { dataDir, component } = fixture();
  try {
    await assert.rejects(runManagedComponent(dataDir, { ...component, provides: ["browser-engine"] }, { requiredRole: "media-processing" }), (error: unknown) => (error as { code?: string }).code === "CMH.COMPONENT.ROLE_MISMATCH");
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("enforces cancellation, timeout and output limits", async () => {
  const { dataDir, component } = fixture();
  try {
    const controller = new AbortController();
    const cancelled = runManagedComponent(dataDir, component, { args: ["-e", "setTimeout(() => {}, 1000)"], signal: controller.signal });
    controller.abort();
    await assert.rejects(cancelled, (error: unknown) => (error as { code?: string }).code === "CMH.CANCELLED");
    await assert.rejects(runManagedComponent(dataDir, component, { args: ["-e", "setTimeout(() => {}, 1000)"], timeoutMs: 100 }), (error: unknown) => (error as { code?: string }).code === "CMH.COMPONENT.TIMEOUT");
    await assert.rejects(runManagedComponent(dataDir, component, { args: ["-e", "process.stdout.write('x'.repeat(2048))"], maxOutputBytes: 1024 }), (error: unknown) => (error as { code?: string }).code === "CMH.COMPONENT.OUTPUT_LIMIT");
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});
