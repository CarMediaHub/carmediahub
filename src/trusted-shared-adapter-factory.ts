import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { WorkerClientOptions } from "@carmediahub/sdk";
import type { TrustedWorkerFactory, TrustedWorkerStart, WorkerHandle } from "./worker-supervisor.js";

export interface TrustedSharedAdapterPackage {
  packageId: string;
  packageRoot: string;
  runtimeEntry: string;
}

interface SharedAdapterModule {
  startWorker(options: WorkerClientOptions): Promise<{ stop(): Promise<void> | void }>;
}

export type SharedAdapterLoader = (url: string) => Promise<unknown>;

function resolveEntry(input: TrustedSharedAdapterPackage): string {
  if (!/^[a-z][a-z0-9-]{1,63}$/u.test(input.packageId)) throw new Error("Trusted shared adapter package ID is invalid");
  if (!/^\.\/[A-Za-z0-9_./-]+$/u.test(input.runtimeEntry) || input.runtimeEntry.includes("..")) throw new Error("Trusted shared adapter entry is invalid");
  const root = path.resolve(input.packageRoot);
  const entry = path.resolve(root, input.runtimeEntry);
  if (!entry.startsWith(root + path.sep) || !fs.existsSync(entry) || !fs.statSync(entry).isFile() || fs.lstatSync(entry).isSymbolicLink()) throw new Error("Trusted shared adapter entry is unavailable");
  return entry;
}

function defaultLoader(url: string): Promise<unknown> { return import(url); }

/**
 * Loads a shared adapter only from an explicit Core trust mapping. The manifest
 * cannot provide a module URL, command, or package root by itself.
 */
export function createTrustedSharedAdapterFactory(input: TrustedSharedAdapterPackage, loader: SharedAdapterLoader = defaultLoader): TrustedWorkerFactory {
  const entry = resolveEntry(input);
  return {
    packageId: input.packageId,
    async start(start: TrustedWorkerStart): Promise<WorkerHandle> {
      const loaded = await loader(pathToFileURL(entry).href) as Partial<SharedAdapterModule> & { default?: Partial<SharedAdapterModule> };
      const module = typeof loaded.startWorker === "function" ? loaded : loaded.default;
      if (module === undefined || typeof module.startWorker !== "function") throw new Error("Trusted shared adapter has no startWorker export");
      const handle = await module.startWorker({ endpoint: start.endpoint, installationId: start.installationId, runtimeCredential: start.runtimeCredential });
      return { stop: () => handle.stop() };
    }
  };
}
