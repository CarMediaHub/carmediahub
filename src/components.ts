import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface ComponentCatalogItem {
  id: string;
  displayName: string;
  kind: "service" | "media-tool" | "utility" | "network-service";
  provides: readonly ("storage-service" | "webdav" | "media-processing" | "archive" | "network-egress" | "browser-engine")[];
  version: string;
  executable: string;
  platforms: readonly string[];
  sha256: string | null;
  status: "catalog-only" | "installed" | "unhealthy" | "disabled";
}

interface CatalogFile { schemaVersion: 1; components: ComponentCatalogItem[]; }

const rolesByKind: Record<ComponentCatalogItem["kind"], readonly ComponentCatalogItem["provides"][number][]> = {
  service: ["storage-service", "webdav", "browser-engine"],
  "media-tool": ["media-processing"],
  utility: ["archive"],
  "network-service": ["network-egress"]
};

export function loadComponentCatalog(projectRoot: string): readonly ComponentCatalogItem[] {
  const location = path.join(projectRoot, "config", "components.json");
  const raw = JSON.parse(fs.readFileSync(location, "utf8")) as CatalogFile;
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.components)) throw new Error("Unsupported component catalog");
  const ids = new Set<string>();
  for (const component of raw.components) {
    if (!/^[a-z][a-z0-9-]+$/.test(component.id)) throw new Error(`Invalid component id: ${component.id}`);
    if (ids.has(component.id)) throw new Error(`Duplicate component id: ${component.id}`);
    ids.add(component.id);
    if (typeof component.displayName !== "string" || component.displayName.trim().length === 0 || component.displayName.length > 120) throw new Error(`Invalid component display name: ${component.id}`);
    if (!["service", "media-tool", "utility", "network-service"].includes(component.kind)) throw new Error(`Invalid component kind: ${component.id}`);
    if (path.isAbsolute(component.executable) || component.executable.includes("..") || component.executable.includes("\\")) throw new Error(`Unsafe component path: ${component.id}`);
    if (!/^([a-z0-9][a-z0-9-]*\/)+[a-z0-9._-]+$/u.test(component.executable)) throw new Error(`Invalid component executable: ${component.id}`);
    if (!Array.isArray(component.platforms) || component.platforms.length === 0 || new Set(component.platforms).size !== component.platforms.length || component.platforms.some((platform) => !/^(windows|linux|darwin)-(x64|arm64)$/u.test(platform))) throw new Error(`Invalid component platforms: ${component.id}`);
    if (component.version !== "not-installed" && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(component.version)) throw new Error(`Invalid component version: ${component.id}`);
    if (component.sha256 !== null && !/^[a-f0-9]{64}$/u.test(component.sha256)) throw new Error(`Invalid component checksum: ${component.id}`);
    if (!["catalog-only", "installed", "unhealthy", "disabled"].includes(component.status)) throw new Error(`Invalid component status: ${component.id}`);
    if (!Array.isArray(component.provides) || component.provides.length === 0 || new Set(component.provides).size !== component.provides.length || component.provides.some((role) => !["storage-service", "webdav", "media-processing", "archive", "network-egress", "browser-engine"].includes(role))) throw new Error(`Invalid component roles: ${component.id}`);
    if (component.provides.some((role) => !rolesByKind[component.kind].includes(role))) throw new Error(`Component role is incompatible with kind: ${component.id}`);
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

export function resolveInstalledComponentRoot(dataDir: string, installed: { id: string; version: string; executable: string }): string {
  if (!/^[a-z][a-z0-9-]{1,63}$/u.test(installed.id) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(installed.version)) throw new Error("Invalid installed component identity");
  const root = path.resolve(dataDir, "components", installed.id, installed.version);
  const managedRoot = path.resolve(dataDir, "components");
  if (!root.startsWith(managedRoot + path.sep) || !fs.existsSync(root) || !fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw new Error("Installed component root is unavailable");
  return root;
}

function collectArtifactFiles(root: string, current = root, entries: string[] = []): string[] {
  for (const item of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const location = path.join(current, item.name);
    const relative = path.relative(root, location).split(path.sep).join("/");
    if (item.isSymbolicLink() || item.isBlockDevice() || item.isCharacterDevice() || item.isFIFO() || item.isSocket()) throw new Error("Installed component contains an unsupported file type");
    if (item.isDirectory()) collectArtifactFiles(root, location, entries);
    else if (item.isFile()) entries.push(relative);
    else throw new Error("Installed component contains an unsupported directory entry");
  }
  return entries;
}

export function computeInstalledComponentDigest(dataDir: string, installed: { id: string; version: string; executable: string }): string {
  const root = resolveInstalledComponentRoot(dataDir, installed);
  const executable = resolveInstalledExecutable(dataDir, installed);
  const files = collectArtifactFiles(root).sort();
  if (files.length === 1 && path.resolve(root, files[0]!) === path.resolve(executable)) return crypto.createHash("sha256").update(fs.readFileSync(executable)).digest("hex");
  const hash = crypto.createHash("sha256");
  for (const relative of files) hash.update(`${relative}\0${crypto.createHash("sha256").update(fs.readFileSync(path.join(root, relative))).digest("hex")}\n`, "utf8");
  return hash.digest("hex");
}

/** Resolve an installed executable only when the catalog grants the requested platform role. */
export function resolveInstalledExecutableForRole(dataDir: string, catalog: readonly ComponentCatalogItem[], installed: { id: string; version: string; executable: string }, role: ComponentCatalogItem["provides"][number]): string {
  const component = catalog.find((item) => item.id === installed.id);
  if (component === undefined || !component.provides.includes(role)) throw new Error(`Component ${installed.id} does not provide ${role}`);
  return resolveInstalledExecutable(dataDir, installed);
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

/** Internal runtime form used by digest-verifying component runners. */
export function normalizeComponentChecksum(checksum: string): string {
  return checksum.startsWith("sha256:") ? checksum.slice("sha256:".length) : checksum;
}
