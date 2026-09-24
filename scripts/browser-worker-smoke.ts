import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { loadComponentCatalog } from "../src/components.js";
import { startBrowserWorker } from "../src/browser-worker-driver.js";
import { BrowserTargetRegistry } from "../src/browser-target-registry.js";

type Options = { runtimeExecutable: string; dataDir: string; keep: boolean };

function parseArgs(argv: readonly string[]): Options {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  let runtimeExecutable = "";
  let dataDir = "";
  let keep = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--runtime-executable") runtimeExecutable = args[++index] ?? "";
    else if (value === "--data-dir") dataDir = args[++index] ?? "";
    else if (value === "--keep") keep = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (runtimeExecutable === "" || dataDir === "") throw new Error("Usage: pnpm smoke:browser -- --runtime-executable <chrome> --data-dir <temporary-data-dir> [--keep]");
  return { runtimeExecutable: path.resolve(runtimeExecutable), dataDir: path.resolve(dataDir), keep };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.statSync(options.runtimeExecutable).isFile()) throw new Error("Runtime executable is not a file");
  const componentDir = path.join(options.dataDir, "components", "chromium", "1.0.0");
  fs.mkdirSync(componentDir, { recursive: true });
  const managedExecutable = path.join(componentDir, process.platform === "win32" ? "chromium.exe" : "chromium");
  fs.copyFileSync(options.runtimeExecutable, managedExecutable, fs.constants.COPYFILE_EXCL);
  const checksum = crypto.createHash("sha256").update(fs.readFileSync(managedExecutable)).digest("hex");
  const registry = new BrowserTargetRegistry();
  registry.register({ id: "example", origins: ["https://example.com"] });
  let worker: Awaited<ReturnType<typeof startBrowserWorker>> | undefined;
  try {
    worker = await startBrowserWorker({
      dataDir: options.dataDir,
      component: { id: "chromium", version: "1.0.0", executable: `chromium/1.0.0/${process.platform === "win32" ? "chromium.exe" : "chromium"}`, checksum },
      catalog: loadComponentCatalog(path.resolve(import.meta.dirname, "..")),
      scope: { organizationId: "smoke-org", userId: "smoke-user", installationId: "smoke-plugin", sessionId: "smoke-session" },
      targetRegistry: registry,
      targetId: "example",
      runtime: { launchPersistentContext: (userDataDir, launchOptions) => chromium.launchPersistentContext(userDataDir, { ...launchOptions, executablePath: options.runtimeExecutable }) }
    });
    const page = await worker.navigate("example", "/");
    const result = { url: page.url(), title: await page.title(), silent: worker.launch.args.includes("--mute-audio"), isolatedUserData: worker.launch.userDataDir.startsWith(path.join(options.dataDir, "browser", "sessions")), duplicateUserDataArg: worker.launch.args.some((arg) => arg.startsWith("--user-data-dir=")) };
    await page.close();
    const blocked = await worker.context.newPage();
    let blockedByPolicy = false;
    try { await blocked.goto("https://example.org/", { waitUntil: "domcontentloaded", timeout: 10_000 }); } catch { blockedByPolicy = true; }
    await blocked.close();
    console.log(JSON.stringify({ ...result, blockedByPolicy }, null, 2));
  } finally {
    await worker?.stop();
    if (!options.keep) fs.rmSync(options.dataDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
