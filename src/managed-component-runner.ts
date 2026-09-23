import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveInstalledExecutable } from "./components.js";

const componentId = /^[a-z][a-z0-9-]{1,63}$/u;
const version = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

export interface ManagedComponentRef { id: string; version: string; executable: string; checksum: string; provides?: readonly string[]; }
export interface ManagedRunOptions { args?: readonly string[]; timeoutMs?: number; maxOutputBytes?: number; signal?: AbortSignal; requiredRole?: string; }
export interface ManagedRunResult { exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; }

async function sha256File(location: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(location)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function runError(code: string): Error & { code: string } {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  return error;
}

function validateArgs(args: readonly string[]): void {
  if (args.length > 128 || args.some((arg) => typeof arg !== "string" || arg.length > 4096 || arg.includes("\0"))) throw runError("CMH.COMPONENT.ARGUMENTS_INVALID");
}

/** Runs only an already verified managed component; it never consults PATH or a shell. */
export function runManagedComponent(dataDir: string, component: ManagedComponentRef, options: ManagedRunOptions = {}): Promise<ManagedRunResult> {
  if (!componentId.test(component.id) || !version.test(component.version) || !/^[a-f0-9]{64}$/u.test(component.checksum)) return Promise.reject(runError("CMH.COMPONENT.IDENTITY_INVALID"));
  if (options.requiredRole !== undefined && (!/^[a-z][a-z0-9-]{0,63}$/u.test(options.requiredRole) || component.provides === undefined || !component.provides.includes(options.requiredRole))) return Promise.reject(runError("CMH.COMPONENT.ROLE_MISMATCH"));
  const args = options.args ?? [];
  try { validateArgs(args); } catch (error) { return Promise.reject(error); }
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600_000 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 16 * 1024 * 1024) return Promise.reject(runError("CMH.COMPONENT.LIMIT_INVALID"));
  let executable: string;
  try { executable = resolveInstalledExecutable(dataDir, component); } catch { return Promise.reject(runError("CMH.COMPONENT.EXECUTABLE_UNAVAILABLE")); }
  return sha256File(executable).catch(() => { throw runError("CMH.COMPONENT.EXECUTABLE_UNAVAILABLE"); }).then((actual) => {
    if (actual !== component.checksum) throw runError("CMH.COMPONENT.DIGEST_MISMATCH");
    if (options.signal?.aborted) throw runError("CMH.CANCELLED");
    return new Promise<ManagedRunResult>((resolve, reject) => {
    if (options.signal?.aborted) { reject(runError("CMH.CANCELLED")); return; }
    let child: ChildProcess;
    try {
      child = spawn(executable, [...args], { cwd: path.resolve(dataDir), env: {}, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch { reject(runError("CMH.COMPONENT.START_FAILED")); return; }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    const onAbort = () => { aborted = true; child.kill(); };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const collect = (target: Buffer[], chunk: Buffer) => {
      if (settled) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) { child.kill(); return; }
      target.push(chunk);
    };
    child.stdout?.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", () => { if (!settled) { settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort); reject(runError("CMH.COMPONENT.START_FAILED")); } });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (timedOut) return reject(runError("CMH.COMPONENT.TIMEOUT"));
      if (aborted) return reject(runError("CMH.CANCELLED"));
      if (outputBytes > maxOutputBytes) return reject(runError("CMH.COMPONENT.OUTPUT_LIMIT"));
      resolve({ exitCode, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
    });
  });
}
