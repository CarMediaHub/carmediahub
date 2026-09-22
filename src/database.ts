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
      time_zone TEXT NOT NULL DEFAULT 'UTC',
      theme TEXT NOT NULL DEFAULT 'system',
      density TEXT NOT NULL DEFAULT 'comfortable',
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
    CREATE TABLE IF NOT EXISTS plugin_installations (
      id TEXT PRIMARY KEY,
      package_id TEXT NOT NULL,
      package_version TEXT NOT NULL,
      runtime TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      granted_capabilities TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(package_id, id)
    );
    CREATE TABLE IF NOT EXISTS verified_plugin_packages (
      package_id TEXT NOT NULL,
      package_version TEXT NOT NULL,
      digest TEXT NOT NULL,
      location TEXT NOT NULL,
      worker_entry TEXT,
      runtime_entry TEXT,
      verified_at TEXT NOT NULL,
      PRIMARY KEY (package_id)
    );
    CREATE TABLE IF NOT EXISTS media_roots (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      installation_id TEXT NOT NULL,
      name TEXT NOT NULL,
      protected_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS playback_sessions (
      token_hash TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id),
      device_id TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      media_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS playback_sessions_scope_index ON playback_sessions (organization_id, user_id, installation_id, expires_at);
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
    CREATE TABLE IF NOT EXISTS media_transform_outputs (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      installation_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      content_type TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS media_transform_outputs_scope_index ON media_transform_outputs (organization_id, user_id, installation_id, expires_at);
    CREATE TABLE IF NOT EXISTS media_hls_sessions (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      installation_id TEXT NOT NULL,
      directory_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS media_hls_sessions_scope_index ON media_hls_sessions (organization_id, user_id, installation_id, expires_at);
    CREATE TABLE IF NOT EXISTS service_bindings (
      id TEXT PRIMARY KEY,
      component_id TEXT NOT NULL REFERENCES managed_components(id),
      name TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      installation_id TEXT,
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
    CREATE TABLE IF NOT EXISTS platform_history (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), installation_id TEXT NOT NULL,
      subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, plugin_id TEXT NOT NULL, route TEXT NOT NULL, title TEXT NOT NULL,
      category TEXT, visited_at TEXT NOT NULL, source_device TEXT NOT NULL, metadata_digest TEXT
    );
    CREATE INDEX IF NOT EXISTS platform_history_scope_index ON platform_history (organization_id, user_id, installation_id, visited_at);
    CREATE TABLE IF NOT EXISTS catalog_entries (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), installation_id TEXT NOT NULL,
      subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, plugin_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
      category TEXT NOT NULL, route TEXT NOT NULL, updated_at TEXT NOT NULL, metadata_digest TEXT
    );
    CREATE INDEX IF NOT EXISTS catalog_entries_scope_index ON catalog_entries (organization_id, user_id, installation_id, updated_at);
    CREATE TABLE IF NOT EXISTS platform_notifications (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), installation_id TEXT NOT NULL,
      plugin_id TEXT NOT NULL, severity TEXT NOT NULL, title TEXT NOT NULL, body TEXT, created_at TEXT NOT NULL, read_at TEXT
    );
    CREATE INDEX IF NOT EXISTS platform_notifications_scope_index ON platform_notifications (organization_id, user_id, installation_id, created_at);
    CREATE TABLE IF NOT EXISTS plugin_jobs (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id),
      installation_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0,
      result_json TEXT,
      error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS plugin_jobs_scope_index
      ON plugin_jobs (organization_id, user_id, installation_id, status, created_at);
    CREATE TABLE IF NOT EXISTS rate_limit_buckets (
      subject_hash TEXT PRIMARY KEY,
      window_started_at TEXT NOT NULL,
      failures INTEGER NOT NULL,
      locked_until TEXT
    );
  `);
  const pluginColumns = db.prepare("PRAGMA table_info(plugin_installations)").all() as Array<{ name?: string }>;
  if (!pluginColumns.some((column) => column.name === "granted_capabilities")) db.exec("ALTER TABLE plugin_installations ADD COLUMN granted_capabilities TEXT");
  // Keep existing self-hosted databases compatible with the package runtime contract.
  const columns = db.prepare("PRAGMA table_info(verified_plugin_packages)").all() as Array<{ name?: string }>;
  if (!columns.some((column) => column.name === "runtime_entry")) db.exec("ALTER TABLE verified_plugin_packages ADD COLUMN runtime_entry TEXT");
  const bindingColumns = db.prepare("PRAGMA table_info(service_bindings)").all() as Array<{ name?: string }>;
  if (!bindingColumns.some((column) => column.name === "installation_id")) db.exec("ALTER TABLE service_bindings ADD COLUMN installation_id TEXT");
  const bindingTable = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'service_bindings'").get() as { sql?: string } | undefined;
  if (bindingTable?.sql?.includes("name TEXT NOT NULL UNIQUE") === true) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        CREATE TABLE service_bindings_v2 (
          id TEXT PRIMARY KEY,
          component_id TEXT NOT NULL REFERENCES managed_components(id),
          name TEXT NOT NULL,
          endpoint TEXT NOT NULL,
          installation_id TEXT,
          created_at TEXT NOT NULL
        );
        INSERT INTO service_bindings_v2 (id, component_id, name, endpoint, installation_id, created_at)
          SELECT id, component_id, name, endpoint, installation_id, created_at FROM service_bindings;
        DROP TABLE service_bindings;
        ALTER TABLE service_bindings_v2 RENAME TO service_bindings;
        CREATE UNIQUE INDEX IF NOT EXISTS service_bindings_scope_name
          ON service_bindings (name, IFNULL(installation_id, '__core__'));
      `);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS service_bindings_scope_name ON service_bindings (name, IFNULL(installation_id, '__core__'))");
  const mediaRootColumns = db.prepare("PRAGMA table_info(media_roots)").all() as Array<{ name: string }>;
  if (!mediaRootColumns.some((column) => column.name === "installation_id")) db.exec("ALTER TABLE media_roots ADD COLUMN installation_id TEXT NOT NULL DEFAULT '__unbound__'");
  const userColumns = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  if (!userColumns.some((column) => column.name === "totp_secret")) db.exec("ALTER TABLE users ADD COLUMN totp_secret TEXT");
  if (!userColumns.some((column) => column.name === "totp_enabled")) db.exec("ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0");
  if (!userColumns.some((column) => column.name === "time_zone")) db.exec("ALTER TABLE users ADD COLUMN time_zone TEXT NOT NULL DEFAULT 'UTC'");
  if (!userColumns.some((column) => column.name === "theme")) db.exec("ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT 'system'");
  if (!userColumns.some((column) => column.name === "density")) db.exec("ALTER TABLE users ADD COLUMN density TEXT NOT NULL DEFAULT 'comfortable'");
  return { db, close: () => db.close() };
}
