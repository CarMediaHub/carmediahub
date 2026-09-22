import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const manifestName = "backup-manifest.json";
// Core uses SQLite WAL mode; an offline snapshot must include any sidecar files
// that may still contain committed pages when the process has stopped.
const managedFiles = ["carmediahub.sqlite", "carmediahub.sqlite-wal", "carmediahub.sqlite-shm", "secrets/session-hmac.key"] as const;
const managedDirectories = ["components", "plugins"] as const;

export interface BackupFile { path: string; bytes: number; sha256: string; }
export interface BackupManifest {
  schemaVersion: 1;
  product: "carmediahub-core";
  createdAt: string;
  source: "offline-snapshot";
  files: readonly BackupFile[];
}

function digest(location: string): BackupFile {
  const hash = crypto.createHash("sha256");
  const stat = fs.statSync(location);
  if (!stat.isFile()) throw new Error("Backup source is not a regular file");
  hash.update(fs.readFileSync(location));
  return { path: location, bytes: stat.size, sha256: hash.digest("hex") };
}

function relativeFiles(root: string, relativeDirectory: string): string[] {
  const directory = path.join(root, relativeDirectory);
  if (!fs.existsSync(directory)) return [];
  if (!fs.statSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw new Error("Backup source directory is invalid");
  const result: string[] = [];
  const visit = (current: string, relative: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const childRelative = path.posix.join(relative, entry.name);
      const child = path.join(root, ...childRelative.split("/"));
      if (entry.isSymbolicLink()) throw new Error("Backup does not accept symbolic links");
      if (entry.isDirectory()) visit(child, childRelative);
      else if (entry.isFile()) result.push(childRelative);
      else throw new Error("Backup contains an unsupported file type");
    }
  };
  visit(directory, relativeDirectory.replaceAll("\\", "/"));
  return result;
}

function assertDestination(source: string, destination: string): void {
  const sourceReal = fs.realpathSync(source);
  const destinationParent = path.dirname(path.resolve(destination));
  fs.mkdirSync(destinationParent, { recursive: true });
  const parentReal = fs.realpathSync(destinationParent);
  const destinationResolved = path.resolve(parentReal, path.basename(destination));
  if (destinationResolved === sourceReal || destinationResolved.startsWith(`${sourceReal}${path.sep}`)) throw new Error("Backup destination must be outside data directory");
  if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) throw new Error("Backup destination cannot be a symbolic link");
}

function copyFile(source: string, destination: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
}

/** Creates an offline, atomic snapshot of Core-owned state. Stop Core before calling this. */
export function createBackupSnapshot(dataDir: string, destination: string): BackupManifest {
  if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) throw new Error("Backup data directory is unavailable");
  assertDestination(dataDir, destination);
  if (fs.existsSync(destination)) throw new Error("Backup destination already exists");
  const temporary = `${path.resolve(destination)}.tmp-${crypto.randomUUID()}`;
  fs.mkdirSync(temporary, { recursive: true });
  try {
    const candidates = [...managedFiles.filter((relative) => fs.existsSync(path.join(dataDir, ...relative.split("/"))),), ...managedDirectories.flatMap((directory) => relativeFiles(dataDir, directory))];
    const files: BackupFile[] = [];
    for (const relative of candidates) {
      const source = path.join(dataDir, ...relative.split("/"));
      const target = path.join(temporary, ...relative.split("/"));
      copyFile(source, target);
      const entry = digest(target);
      files.push({ ...entry, path: relative.replaceAll("\\", "/") });
    }
    const manifest: BackupManifest = { schemaVersion: 1, product: "carmediahub-core", createdAt: new Date().toISOString(), source: "offline-snapshot", files };
    fs.writeFileSync(path.join(temporary, manifestName), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, destination);
    return manifest;
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

/** Verifies a snapshot without extracting or executing anything from it. */
export function verifyBackupSnapshot(snapshot: string): BackupManifest {
  const manifestPath = path.join(snapshot, manifestName);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as BackupManifest;
  if (manifest.schemaVersion !== 1 || manifest.product !== "carmediahub-core" || manifest.source !== "offline-snapshot" || !Array.isArray(manifest.files)) throw new Error("Backup manifest is invalid");
  const seen = new Set<string>();
  for (const entry of manifest.files) {
    if (typeof entry.path !== "string" || entry.path.length === 0 || entry.path.includes("..") || path.isAbsolute(entry.path) || seen.has(entry.path) || !/^[a-f0-9]{64}$/u.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw new Error("Backup manifest file entry is invalid");
    seen.add(entry.path);
    const location = path.resolve(snapshot, ...entry.path.split("/"));
    if (!location.startsWith(path.resolve(snapshot) + path.sep) || !fs.existsSync(location) || fs.lstatSync(location).isSymbolicLink()) throw new Error("Backup file is unavailable");
    const actual = digest(location);
    if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) throw new Error("Backup file digest mismatch");
  }
  return manifest;
}
