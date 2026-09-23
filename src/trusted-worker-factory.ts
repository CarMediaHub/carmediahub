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
      const child = childProcess.spawn(process.execPath, [runner, "--entry", entry, "--endpoint", start.endpoint, "--installation-id", start.installationId], { shell: false, windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
      child.stdin.end(JSON.stringify({ runtimeCredential: start.runtimeCredential }));
      let crashListener: ((error: Error) => void) | undefined;
      child.once("error", (error) => crashListener?.(error));
      child.once("exit", (code, signal) => { if (code !== 0 && signal !== "SIGTERM") crashListener?.(new Error(`Worker exited (${code ?? signal ?? "unknown"})`)); });
      return {
        stop: () => { if (!child.killed) child.kill("SIGTERM"); },
        onCrash: (listener) => { crashListener = listener; }
      };
    }
  };
}
