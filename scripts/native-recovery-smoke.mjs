import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { spawn } from "node:child_process";

const execFileAsync = promisify(execFile);

function fail(message) { throw new Error(`Native recovery smoke failed: ${message}`); }

export function parseNativeRecoveryArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key !== "--bundle-root" || value === undefined || value.startsWith("--")) fail("usage: smoke:native-recovery --bundle-root <absolute path>");
    values.set(key, value);
  }
  const bundleRoot = values.get("--bundle-root");
  if (typeof bundleRoot !== "string" || !path.isAbsolute(bundleRoot)) fail("--bundle-root must be absolute");
  return path.resolve(bundleRoot);
}

async function waitForLive(baseUrl, child, getStderr) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) fail(`Core exited before liveness with code ${child.exitCode}${getStderr().length > 0 ? `: ${getStderr().trim()}` : ""}`);
    try {
      const response = await fetch(`${baseUrl}/health/live`);
      if (response.status === 200) return;
    } catch { /* wait for the explicit startup window */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail("liveness did not become ready");
}

export async function runNativeRecoverySmoke(bundleRoot) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cmh-native-recovery-data-"));
  const restoredDir = `${dataDir}-restored`;
  const snapshot = `${dataDir}-snapshot`;
  const port = 18987;
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(bundleRoot, "dist", "cli.js"), "--data-dir", dataDir, "--host", "127.0.0.1", "--port", String(port)], { cwd: bundleRoot, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });

  try {
    await waitForLive(baseUrl, child, () => stderr);
    const bootstrap = await fetch(`${baseUrl}/api/bootstrap`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "smoke-admin", password: "correct horse battery staple", locale: "en" }) });
    if (bootstrap.status !== 201) fail(`bootstrap returned ${bootstrap.status}`);
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
    }
  }
  try {
    await execFileAsync(process.execPath, [path.join(bundleRoot, "dist", "backup-cli.js"), "backup", "--data-dir", dataDir, "--output", snapshot], { cwd: bundleRoot });
    await execFileAsync(process.execPath, [path.join(bundleRoot, "dist", "backup-cli.js"), "restore", "--snapshot", snapshot, "--data-dir", restoredDir], { cwd: bundleRoot });
    const { stdout } = await execFileAsync(process.execPath, [path.join(bundleRoot, "scripts", "upgrade-preflight.mjs"), "--bundle-root", bundleRoot, "--data-dir", dataDir, "--snapshot", snapshot], { cwd: bundleRoot });
    const result = JSON.parse(stdout);
    if (result.currentSchemaVersion !== result.targetSchemaVersion) fail("schema versions do not match");
    const summary = { bundleFiles: result.bundleRoot === bundleRoot, restored: true, currentSchemaVersion: result.currentSchemaVersion, targetSchemaVersion: result.targetSchemaVersion };
    console.log(JSON.stringify(summary));
    return summary;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`${detail}${stderr.length > 0 ? `; ${stderr.trim()}` : ""}`);
  } finally {
    await Promise.all([fs.rm(dataDir, { recursive: true, force: true }), fs.rm(restoredDir, { recursive: true, force: true }), fs.rm(snapshot, { recursive: true, force: true })]);
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runNativeRecoverySmoke(parseNativeRecoveryArgs(process.argv.slice(2).filter((value) => value !== "--")));
