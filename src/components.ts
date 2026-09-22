import fs from "node:fs";
import path from "node:path";

export interface ComponentCatalogItem {
  id: string;
  displayName: string;
  kind: "service" | "media-tool" | "utility" | "network-service";
  provides: readonly ("storage-service" | "webdav" | "media-processing" | "archive" | "network-egress")[];
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
    if (!Array.isArray(component.provides) || component.provides.length === 0 || new Set(component.provides).size !== component.provides.length || component.provides.some((role) => !["storage-service", "webdav", "media-processing", "archive", "network-egress"].includes(role))) throw new Error(`Invalid component roles: ${component.id}`);
  }
  return raw.components;
}

export function resolveManagedExecutable(dataDir: string, component: ComponentCatalogItem): string {
  const resolved = path.resolve(dataDir, "components", ...path.posix.dirname(component.executable).split("/"), componentExecutableName(component));
  const root = path.resolve(dataDir, "components") + path.sep;
  if (!resolved.startsWith(root)) throw new Error("Component path escaped managed directory");
  return resolved;
}

/** Resolve only a persisted, verified installation record; never consults PATH. */
export function resolveInstalledExecutable(dataDir: string, installed: { id: string; version: string; executable: string }): string {
  if (!/^[a-z][a-z0-9-]{1,63}$/u.test(installed.id) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(installed.version)) throw new Error("Invalid installed component identity");
  if (installed.executable.includes("\\") || path.isAbsolute(installed.executable) || installed.executable.includes("..") || !installed.executable.startsWith(`${installed.id}/${installed.version}/`)) throw new Error("Invalid installed component executable");
  const root = path.resolve(dataDir, "components");
  const resolved = path.resolve(root, ...installed.executable.split("/"));
  if (!resolved.startsWith(root + path.sep) || !isRegularPathWithoutLinks(root, resolved)) throw new Error("Installed component executable is unavailable");
  return resolved;
}

function isRegularPathWithoutLinks(root: string, resolved: string): boolean {
  if (!fs.existsSync(root) || fs.lstatSync(root).isSymbolicLink()) return false;
  const relative = path.relative(root, resolved);
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current) || fs.lstatSync(current).isSymbolicLink()) return false;
  }
  return fs.lstatSync(resolved).isFile();
}

export function currentPlatformKey(): string {
  const system = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : process.platform;
  const architecture = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : process.arch;
  return `${system}-${architecture}`;
}

export function componentExecutableName(component: ComponentCatalogItem): string {
  if (!component.platforms.includes(currentPlatformKey())) throw new Error(`Component ${component.id} is not available on ${currentPlatformKey()}`);
  const name = path.posix.basename(component.executable);
  return process.platform === "win32" && path.extname(name) === "" ? `${name}.exe` : name;
}
