import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const identifier = /^[a-z][a-z0-9-]{1,63}$/u;
const version = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const checksum = /^[a-f0-9]{64}$/u;

export interface InstalledPluginPackage {
  packageId: string;
  version: string;
  digest: string;
  /** Relative to the deployment data directory; never expose a host path to a plugin. */
  location: string;
}

function fileDigest(location: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(location)).digest("hex");
}

function collect(root: string, current = root, entries: string[] = []): string[] {
  for (const item of fs.readdirSync(current, { withFileTypes: true })) {
    const location = path.join(current, item.name);
    const relative = path.relative(root, location).split(path.sep).join("/");
    if (item.isSymbolicLink() || item.isBlockDevice() || item.isCharacterDevice() || item.isFIFO() || item.isSocket()) throw new Error("Plugin package contains an unsupported file type");
    if (item.isDirectory()) collect(root, location, entries);
    else if (item.isFile()) entries.push(relative);
    else throw new Error("Plugin package contains an unsupported entry");
  }
  return entries;
}

/**
 * Accepts only a Core-owned staged directory and derives its digest from every
 * relative path and file content. The installed root is immutable by convention.
 */
export function installStagedPluginPackage(dataDir: string, input: { packageId: string; version: string; artifactId: string; digest: string; workerEntry?: string }): InstalledPluginPackage {
  if (!identifier.test(input.packageId) || !version.test(input.version) || !identifier.test(input.artifactId) || !checksum.test(input.digest)) throw new Error("Invalid plugin package installation request");
  const stagingRoot = path.resolve(dataDir, "staging", "plugins");
  const source = path.resolve(stagingRoot, input.artifactId);
  if (!source.startsWith(stagingRoot + path.sep) || !fs.existsSync(source) || !fs.statSync(source).isDirectory() || fs.lstatSync(source).isSymbolicLink()) throw new Error("Staged plugin package not found");
  if (input.workerEntry !== undefined) {
    if (!/^\.\/[A-Za-z0-9_./-]+$/u.test(input.workerEntry) || input.workerEntry.includes("..")) throw new Error("Plugin worker entry is invalid");
    const worker = path.resolve(source, input.workerEntry);
    if (!worker.startsWith(source + path.sep) || !fs.existsSync(worker) || !fs.lstatSync(worker).isFile() || fs.lstatSync(worker).isSymbolicLink()) throw new Error("Plugin worker entry is unavailable");
  }
  const entries = collect(source).sort();
  if (entries.length === 0) throw new Error("Staged plugin package is empty");
  const hash = crypto.createHash("sha256");
  for (const relative of entries) hash.update(`${relative}\0${fileDigest(path.join(source, relative))}\n`, "utf8");
  const actualDigest = hash.digest("hex");
  if (actualDigest !== input.digest) throw new Error("Staged plugin package digest mismatch");
  const packageRoot = path.resolve(dataDir, "plugins", input.packageId, input.version);
  const finalDirectory = path.resolve(packageRoot, actualDigest);
  const temporaryDirectory = path.resolve(packageRoot, `.install-${crypto.randomUUID()}`);
  if (!finalDirectory.startsWith(packageRoot + path.sep) || !temporaryDirectory.startsWith(packageRoot + path.sep) || fs.existsSync(finalDirectory)) throw new Error("Plugin package destination is invalid");
  fs.mkdirSync(temporaryDirectory, { recursive: true });
  try {
    for (const relative of entries) {
      const target = path.resolve(temporaryDirectory, relative);
      if (!target.startsWith(temporaryDirectory + path.sep)) throw new Error("Plugin package path escaped root");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(source, relative), target, fs.constants.COPYFILE_EXCL);
    }
    fs.renameSync(temporaryDirectory, finalDirectory);
  } catch (error) {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
  return { packageId: input.packageId, version: input.version, digest: actualDigest, location: path.posix.join("plugins", input.packageId, input.version, actualDigest) };
}
