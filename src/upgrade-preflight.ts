import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { verifyBackupSnapshot, type BackupManifest } from "./backup-service.js";

export interface UpgradePreflightInput {
  bundleRoot: string;
  dataDir: string;
  snapshot: string;
  targetBundleVersion: string;
  targetSchemaVersion: number;
}

export interface UpgradePreflightResult {
  bundleRoot: string;
  dataDir: string;
  snapshot: string;
  currentSchemaVersion: number;
  targetSchemaVersion: number;
  targetBundleVersion: string;
  snapshotCreatedAt: string;
}

function fail(message: string): never { throw new Error(`Upgrade preflight failed: ${message}`); }

function absolute(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || !path.isAbsolute(value)) fail(`${label} must be an absolute path`);
  return path.resolve(value);
}

function regularDirectory(location: string, label: string): string {
  if (!fs.existsSync(location) || fs.lstatSync(location).isSymbolicLink() || !fs.statSync(location).isDirectory()) fail(`${label} is unavailable or symbolic`);
  return location;
}

function regularFile(location: string, label: string): string {
  if (!fs.existsSync(location) || fs.lstatSync(location).isSymbolicLink() || !fs.statSync(location).isFile()) fail(`${label} is unavailable or symbolic`);
  return location;
}

function digest(location: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(location)).digest("hex");
}

function databaseVersion(location: string): number {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(location, { readOnly: true });
    const value = Number((db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined)?.user_version ?? 0);
    if (!Number.isSafeInteger(value) || value < 0) fail("current database schema version is invalid");
    return value;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Upgrade preflight failed:")) throw error;
    fail("current database cannot be read");
    return 0;
  } finally {
    db?.close();
  }
}

function databaseEntry(manifest: BackupManifest): { path: string; sha256: string } {
  const entry = manifest.files.find((candidate) => candidate.path === "carmediahub.sqlite");
  if (entry === undefined) fail("snapshot does not contain the Core database");
  return entry;
}

export function checkUpgradePreflight(input: UpgradePreflightInput): UpgradePreflightResult {
  const bundleRoot = regularDirectory(absolute(input.bundleRoot, "bundleRoot"), "bundleRoot");
  const dataDir = regularDirectory(absolute(input.dataDir, "dataDir"), "dataDir");
  const snapshot = regularDirectory(absolute(input.snapshot, "snapshot"), "snapshot");
  if (typeof input.targetBundleVersion !== "string" || input.targetBundleVersion.length === 0) fail("targetBundleVersion is invalid");
  if (!Number.isSafeInteger(input.targetSchemaVersion) || input.targetSchemaVersion < 1) fail("targetSchemaVersion is invalid");
  const database = regularFile(path.join(dataDir, "carmediahub.sqlite"), "current database");
  const dataReal = fs.realpathSync(dataDir);
  const snapshotReal = fs.realpathSync(snapshot);
  if (snapshotReal === dataReal || snapshotReal.startsWith(`${dataReal}${path.sep}`)) fail("snapshot must be outside data directory");
  const manifest = verifyBackupSnapshot(snapshot);
  const currentSchemaVersion = databaseVersion(database);
  if (currentSchemaVersion > input.targetSchemaVersion) fail(`database schema version ${currentSchemaVersion} is newer than target support ${input.targetSchemaVersion}`);
  const snapshotDatabase = databaseEntry(manifest);
  if (digest(database) !== snapshotDatabase.sha256) fail("snapshot database does not match current data");
  return { bundleRoot, dataDir, snapshot, currentSchemaVersion, targetSchemaVersion: input.targetSchemaVersion, targetBundleVersion: input.targetBundleVersion, snapshotCreatedAt: manifest.createdAt };
}
