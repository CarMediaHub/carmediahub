import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export interface CoreDatabase {
  db: DatabaseSync;
  close(): void;
}

export function openDatabase(dataDir: string): CoreDatabase {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "carmediahub.sqlite"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS deployments (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      locale TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      deployment_id TEXT NOT NULL REFERENCES deployments(id),
      name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      locale TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      totp_secret TEXT,
      totp_enabled INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      token_hash TEXT NOT NULL UNIQUE,
      device_label TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS applications (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      route TEXT NOT NULL UNIQUE,
      installation_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      vehicle_supported INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS entry_keys (
      id TEXT PRIMARY KEY,
      key_hash TEXT NOT NULL UNIQUE,
      application_id TEXT NOT NULL REFERENCES applications(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      expires_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS managed_components (
      id TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      executable TEXT NOT NULL,
      checksum TEXT NOT NULL,
      installed_at TEXT NOT NULL,
      health TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS service_bindings (
      id TEXT PRIMARY KEY,
      component_id TEXT NOT NULL REFERENCES managed_components(id),
      name TEXT NOT NULL UNIQUE,
      endpoint TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      actor_id TEXT,
      type TEXT NOT NULL,
      subject TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recovery_codes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      code_hash TEXT NOT NULL UNIQUE,
      used_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plugin_data (
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id),
      installation_id TEXT NOT NULL,
      collection TEXT NOT NULL,
      record_key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, user_id, installation_id, collection, record_key)
    );
    CREATE INDEX IF NOT EXISTS plugin_data_scope_index
      ON plugin_data (organization_id, user_id, installation_id, collection, record_key);
  `);
  const userColumns = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  if (!userColumns.some((column) => column.name === "totp_secret")) db.exec("ALTER TABLE users ADD COLUMN totp_secret TEXT");
  if (!userColumns.some((column) => column.name === "totp_enabled")) db.exec("ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0");
  return { db, close: () => db.close() };
}
