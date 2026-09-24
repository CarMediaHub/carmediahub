import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { TrustedWorkerFactory, TrustedWorkerStart, WorkerHandle } from "./worker-supervisor.js";

export interface TrustedWorkerPackage {
  packageId: string;
  packageVersion?: string;
  packageRoot: string;
  workerEntry: string;
}

function resolveWorkerEntry(input: TrustedWorkerPackage): string {
  if (!/^\.\/[A-Za-z0-9_./-]+$/u.test(input.workerEntry) || input.workerEntry.includes("..")) throw new Error("Trusted worker entry is invalid");
  const root = path.resolve(input.packageRoot);
  const entry = path.resolve(root, input.workerEntry);
  if (!entry.startsWith(root + path.sep) || !fs.existsSync(entry) || !fs.statSync(entry).isFile()) throw new Error("Trusted worker entry is unavailable");
  return entry;
}

export function windowsTaskkillPath(nodeExecutable = process.execPath): string {
  const root = path.win32.parse(nodeExecutable).root;
  return path.win32.join(root, "Windows", "System32", "taskkill.exe");
}

/**
 * Executes only a fixed runner with a package-relative entry previously
 * approved by the Core package verifier. It never accepts a shell command.
 */
export function createTrustedNodeWorkerFactory(input: TrustedWorkerPackage): TrustedWorkerFactory {
  const entry = resolveWorkerEntry(input);
  const runner = path.resolve(import.meta.dirname, "..", "scripts", "worker-runner.mjs");
  if (!fs.existsSync(runner)) throw new Error("Core worker runner is unavailable");
  return {
    packageId: input.packageId,
    packageVersion: input.packageVersion,
    async start(start: TrustedWorkerStart): Promise<WorkerHandle> {
      const child = childProcess.spawn(process.execPath, [runner, "--entry", entry, "--endpoint", start.endpoint, "--installation-id", start.installationId], { env: {}, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
      child.stdin.end(JSON.stringify({ runtimeCredential: start.runtimeCredential }));
      let crashListener: ((error: Error) => void) | undefined;
      child.once("error", (error) => crashListener?.(error));
      child.once("exit", (code, signal) => { if (code !== 0 && signal !== "SIGTERM") crashListener?.(new Error(`Worker exited (${code ?? signal ?? "unknown"})`)); });
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let output = "";
        const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); error === undefined ? resolve() : reject(error); };
        const timer = setTimeout(() => finish(new Error("Worker readiness timed out")), 5_000);
        child.stdout?.on("data", (chunk: Buffer) => {
          output += chunk.toString("utf8");
          if (output.split(/\r?\n/u).includes("ready")) finish();
          if (output.length > 256) finish(new Error("Worker readiness output is invalid"));
        });
        child.once("exit", (code, signal) => finish(new Error(`Worker exited before ready (${code ?? signal ?? "unknown"})`)));
        child.once("error", (error) => finish(error));
      }).catch(async (error) => { if (!child.killed) child.kill("SIGTERM"); throw error; });
      return {
        stop: () => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          if (process.platform === "win32" && child.pid !== undefined) {
            const taskkill = windowsTaskkillPath();
            if (fs.existsSync(taskkill)) childProcess.spawnSync(taskkill, ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", env: {} });
            else if (!child.killed) child.kill("SIGTERM");
          } else if (!child.killed) child.kill("SIGTERM");
        },
        onCrash: (listener) => { crashListener = listener; }
      };
    }
  };
}
