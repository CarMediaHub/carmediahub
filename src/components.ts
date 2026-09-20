import fs from "node:fs";
import path from "node:path";

export interface ComponentCatalogItem {
  id: string;
  displayName: string;
  kind: "service" | "media-tool" | "utility" | "network-service";
  version: string;
  executable: string;
  platforms: readonly string[];
  sha256: string | null;
  status: "catalog-only" | "installed" | "unhealthy" | "disabled";
}

interface CatalogFile { schemaVersion: 1; components: ComponentCatalogItem[]; }

export function loadComponentCatalog(projectRoot: string): readonly ComponentCatalogItem[] {
  const location = path.join(projectRoot, "config", "components.json");
  const raw = JSON.parse(fs.readFileSync(location, "utf8")) as CatalogFile;
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.components)) throw new Error("Unsupported component catalog");
  for (const component of raw.components) {
    if (!/^[a-z][a-z0-9-]+$/.test(component.id)) throw new Error(`Invalid component id: ${component.id}`);
    if (path.isAbsolute(component.executable) || component.executable.includes("..") || component.executable.includes("\\")) throw new Error(`Unsafe component path: ${component.id}`);
  }
  return raw.components;
}

export function resolveManagedExecutable(dataDir: string, component: ComponentCatalogItem): string {
  const resolved = path.resolve(dataDir, "components", component.executable);
  const root = path.resolve(dataDir, "components") + path.sep;
  if (!resolved.startsWith(root)) throw new Error("Component path escaped managed directory");
  return resolved;
}
