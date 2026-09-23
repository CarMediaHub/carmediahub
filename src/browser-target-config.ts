import fs from "node:fs";
import path from "node:path";
import { BrowserTargetRegistry } from "./browser-target-registry.js";

interface BrowserTargetConfig { schemaVersion: 1; targets: Array<{ id: string; origins: string[] }>; }

/** Loads deployment-owned logical browser targets without discovering hosts or environment variables. */
export function loadBrowserTargetRegistry(dataDir: string): BrowserTargetRegistry {
  const registry = new BrowserTargetRegistry();
  const location = path.join(dataDir, "browser-targets.json");
  if (!fs.existsSync(location)) return registry;
  const raw = JSON.parse(fs.readFileSync(location, "utf8")) as Partial<BrowserTargetConfig>;
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.targets) || raw.targets.length > 64) throw new Error("Invalid browser target configuration");
  for (const target of raw.targets) {
    if (target === null || typeof target !== "object" || typeof target.id !== "string" || !Array.isArray(target.origins) || target.origins.some((origin) => typeof origin !== "string")) throw new Error("Invalid browser target configuration");
    registry.register({ id: target.id, origins: target.origins });
  }
  return registry;
}
