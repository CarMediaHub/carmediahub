import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cmh-startup-smoke-"));
const port = 18000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["--import", "tsx", path.join(root, "src", "cli.ts"), "--", "--data-dir", dataDir, "--port", String(port)], { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let output = "";
child.stdout.on("data", (chunk) => { output += String(chunk); });
child.stderr.on("data", (chunk) => { output += String(chunk); });

async function request(pathname, init) {
  return fetch(`${baseUrl}${pathname}`, init);
}

try {
  let live;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { live = await request("/health/live"); if (live.ok) break; } catch { /* wait for startup */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (live?.status !== 200) throw new Error(`liveness did not become ready: ${output}`);
  const bootstrap = await request("/api/bootstrap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "smoke-admin", password: "correct horse battery staple", locale: "en" }) });
  if (bootstrap.status !== 201) throw new Error(`bootstrap returned ${bootstrap.status}`);
  const ready = await request("/health/ready");
  if (ready.status !== 200) throw new Error(`readiness returned ${ready.status}`);
  console.log(JSON.stringify({ liveness: live.status, bootstrap: bootstrap.status, readiness: ready.status }));
} finally {
  child.kill();
  await new Promise((resolve) => child.once("exit", resolve));
  await fs.rm(dataDir, { recursive: true, force: true });
}
