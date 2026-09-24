import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { componentExecutableName, type ComponentCatalogItem } from "./components.js";

const identifier = /^[a-z][a-z0-9-]{1,63}$/u;
const version = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const checksum = /^[a-f0-9]{64}$/u;

export interface InstalledComponent {
  id: string;
  version: string;
  executable: string;
  checksum: string;
}

function sha256(location: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(location)).digest("hex");
}

function collectFiles(root: string, current = root, entries: string[] = []): string[] {
  for (const item of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const location = path.join(current, item.name);
    const relative = path.relative(root, location).split(path.sep).join("/");
    if (item.isSymbolicLink() || item.isBlockDevice() || item.isCharacterDevice() || item.isFIFO() || item.isSocket()) throw new Error("Component artifact contains an unsupported file type");
    if (item.isDirectory()) collectFiles(root, location, entries);
    else if (item.isFile()) entries.push(relative);
    else throw new Error("Component artifact contains an unsupported directory entry");
  }
  return entries;
}

function artifactDigest(location: string): string {
  const stat = fs.lstatSync(location);
  if (stat.isFile()) return sha256(location);
  const hash = crypto.createHash("sha256");
  for (const relative of collectFiles(location).sort()) hash.update(`${relative}\0${sha256(path.join(location, relative))}\n`, "utf8");
  return hash.digest("hex");
}

/** Installs a verified staged binary without resolving the host PATH. */
export function installStagedComponent(dataDir: string, catalog: readonly ComponentCatalogItem[], input: { componentId: string; version: string; artifactId: string; sha256: string }): InstalledComponent {
  if (!identifier.test(input.componentId) || !identifier.test(input.artifactId) || !version.test(input.version) || !checksum.test(input.sha256)) throw new Error("Invalid component installation request");
  const component = catalog.find((item) => item.id === input.componentId);
  if (component === undefined) throw new Error("Unknown managed component");
  const stagingRoot = path.resolve(dataDir, "staging");
  const source = path.resolve(stagingRoot, input.artifactId);
  if (!source.startsWith(stagingRoot + path.sep) || !fs.existsSync(source) || fs.lstatSync(source).isSymbolicLink() || (!fs.lstatSync(source).isFile() && !fs.lstatSync(source).isDirectory())) throw new Error("Staged artifact not found");
  const actualChecksum = artifactDigest(source);
  if (actualChecksum !== input.sha256) throw new Error("Staged artifact checksum mismatch");
  const executableName = componentExecutableName(component);
  const componentRoot = path.resolve(dataDir, "components", component.id);
  const finalDirectory = path.resolve(componentRoot, input.version);
  const temporaryDirectory = path.resolve(componentRoot, `.install-${input.version}-${crypto.randomUUID()}`);
  if (!finalDirectory.startsWith(componentRoot + path.sep) || !temporaryDirectory.startsWith(componentRoot + path.sep)) throw new Error("Managed component path escaped root");
  if (fs.existsSync(finalDirectory)) throw new Error("Component version is already installed");
  fs.mkdirSync(temporaryDirectory, { recursive: true });
  const target = path.join(temporaryDirectory, executableName);
  try {
    if (fs.lstatSync(source).isDirectory()) {
      const entries = collectFiles(source).sort();
      if (!entries.includes(executableName)) throw new Error("Component artifact is missing its catalog executable");
      for (const relative of entries) {
        const destination = path.resolve(temporaryDirectory, relative);
        if (!destination.startsWith(temporaryDirectory + path.sep)) throw new Error("Component artifact path escaped root");
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(path.join(source, relative), destination, fs.constants.COPYFILE_EXCL);
      }
    } else fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    if (process.platform !== "win32") fs.chmodSync(target, 0o750);
    fs.renameSync(temporaryDirectory, finalDirectory);
  } catch (error) {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
  return { id: component.id, version: input.version, executable: path.posix.join(component.id, input.version, executableName), checksum: actualChecksum };
}
