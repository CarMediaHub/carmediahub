import { Pool, type PoolConfig, type QueryResultRow } from "pg";
import type { DataRecord, PluginDataMigration, PluginDataStore, ScopeContext } from "@carmediahub/sdk";
import { MAX_PLUGIN_DATA_EXPORT_BYTES, MAX_PLUGIN_DATA_EXPORT_RECORDS, type PluginDataExport } from "./data-service.js";

const identifier = /^[a-z][a-z0-9_-]{0,63}$/u;
const migrationName = /^[a-z][a-z0-9_.-]{0,127}$/u;

function assertIdentifier(value: string, field: string): void {
  if (!identifier.test(value)) throw new Error(`${field} must be a lowercase identifier`);
}

function scopeValues(scope: ScopeContext): [string, string, string] {
  assertIdentifier(scope.organizationId, "organizationId");
  assertIdentifier(scope.userId, "userId");
  assertIdentifier(scope.installationId, "installationId");
  return [scope.organizationId, scope.userId, scope.installationId];
}

export interface PostgresQueryResult<T extends QueryResultRow = QueryResultRow> {
  rows: T[];
  rowCount: number | null;
}

export interface PostgresQueryClient {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<PostgresQueryResult<T>>;
}

export const POSTGRES_PLUGIN_DATA_SCHEMA = `
CREATE TABLE IF NOT EXISTS carmediahub_plugin_data (
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  record_key TEXT NOT NULL,
  value_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
PRIMARY KEY (organization_id, user_id, installation_id, collection, record_key)
);
CREATE TABLE IF NOT EXISTS carmediahub_plugin_data_migrations (
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (organization_id, user_id, installation_id, version)
)`;

export async function ensurePostgresPluginDataSchema(client: PostgresQueryClient): Promise<void> {
  await client.query(POSTGRES_PLUGIN_DATA_SCHEMA);
}

export async function exportPostgresPluginData(client: PostgresQueryClient, scope: ScopeContext): Promise<PluginDataExport> {
  const [organizationId, userId, installationId] = scopeValues(scope);
  const rows = (await client.query<{ collection: string; record_key: string; value_json: unknown; updated_at: string }>(
    "SELECT collection, record_key, value_json, updated_at FROM carmediahub_plugin_data WHERE organization_id = $1 AND user_id = $2 AND installation_id = $3 ORDER BY collection, record_key LIMIT $4",
    [organizationId, userId, installationId, MAX_PLUGIN_DATA_EXPORT_RECORDS + 1]
  )).rows;
  if (rows.length > MAX_PLUGIN_DATA_EXPORT_RECORDS) throw new Error("Plugin data export exceeds record limit");
  const grouped = new Map<string, DataRecord[]>();
  for (const row of rows) {
    const records = grouped.get(row.collection) ?? [];
    records.push({ key: row.record_key, value: row.value_json, updatedAt: row.updated_at });
    grouped.set(row.collection, records);
  }
  const migrations = (await client.query<{ version: number; name: string; applied_at: string }>(
    "SELECT version, name, applied_at FROM carmediahub_plugin_data_migrations WHERE organization_id = $1 AND user_id = $2 AND installation_id = $3 ORDER BY version",
    [organizationId, userId, installationId]
  )).rows.map((row) => ({ version: row.version, name: row.name, appliedAt: row.applied_at }));
  const result: PluginDataExport = { exportedAt: new Date().toISOString(), scope: { organizationId, userId, installationId }, migrations, collections: [...grouped.entries()].map(([name, records]) => ({ name, records })) };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_PLUGIN_DATA_EXPORT_BYTES) throw new Error("Plugin data export exceeds byte limit");
  return result;
}

export async function deletePostgresPluginData(client: PostgresQueryClient, scope: ScopeContext): Promise<number> {
  const [organizationId, userId, installationId] = scopeValues(scope);
  await client.query("BEGIN");
  try {
    const deleted = await client.query("DELETE FROM carmediahub_plugin_data WHERE organization_id = $1 AND user_id = $2 AND installation_id = $3", [organizationId, userId, installationId]);
    await client.query("DELETE FROM carmediahub_plugin_data_migrations WHERE organization_id = $1 AND user_id = $2 AND installation_id = $3", [organizationId, userId, installationId]);
    await client.query("COMMIT");
    return deleted.rowCount ?? 0;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

/** Core-only PostgreSQL adapter. The client is created by Core; plugins never see it. */
export function createPostgresPluginDataStore(client: PostgresQueryClient, scope: ScopeContext): PluginDataStore {
  const [organizationId, userId, installationId] = scopeValues(scope);
  const address = (collection: string, key?: string) => {
    assertIdentifier(collection, "collection");
    if (key !== undefined) assertIdentifier(key, "key");
    return key === undefined ? [organizationId, userId, installationId, collection] : [organizationId, userId, installationId, collection, key];
  };
  return {
    async get<T>(collection: string, key: string): Promise<DataRecord<T> | undefined> {
      const values = address(collection, key);
      const result = await client.query<{ record_key: string; value_json: T; updated_at: string }>(
        "SELECT record_key, value_json, updated_at FROM carmediahub_plugin_data WHERE organization_id = $1 AND user_id = $2 AND installation_id = $3 AND collection = $4 AND record_key = $5",
        values
      );
      const row = result.rows[0];
      return row === undefined ? undefined : { key: row.record_key, value: row.value_json, updatedAt: row.updated_at };
    },
    async put<T>(collection: string, key: string, value: T): Promise<DataRecord<T>> {
      const values = address(collection, key);
      const updatedAt = new Date().toISOString();
      await client.query(
        `INSERT INTO carmediahub_plugin_data (organization_id, user_id, installation_id, collection, record_key, value_json, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         ON CONFLICT (organization_id, user_id, installation_id, collection, record_key)
         DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = EXCLUDED.updated_at`,
        [...values, JSON.stringify(value), updatedAt]
      );
      return { key, value, updatedAt };
    },
    async delete(collection: string, key: string): Promise<boolean> {
      const values = address(collection, key);
      const result = await client.query(
        "DELETE FROM carmediahub_plugin_data WHERE organization_id = $1 AND user_id = $2 AND installation_id = $3 AND collection = $4 AND record_key = $5",
        values
      );
      return (result.rowCount ?? 0) > 0;
    },
    async list<T>(collection: string, options: { prefix?: string; limit?: number } = {}): Promise<readonly DataRecord<T>[]> {
      const prefix = options.prefix ?? "";
      assertIdentifier(collection, "collection");
      if (prefix.length > 0) assertIdentifier(prefix, "prefix");
      const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
      const result = await client.query<{ record_key: string; value_json: T; updated_at: string }>(
        `SELECT record_key, value_json, updated_at FROM carmediahub_plugin_data
         WHERE organization_id = $1 AND user_id = $2 AND installation_id = $3 AND collection = $4 AND record_key LIKE $5
         ORDER BY record_key LIMIT $6`,
        [organizationId, userId, installationId, collection, `${prefix}%`, limit]
      );
      return result.rows.map((row) => ({ key: row.record_key, value: row.value_json, updatedAt: row.updated_at }));
    },
    async migrate(input: { version: number; name: string }): Promise<PluginDataMigration> {
      if (!Number.isSafeInteger(input.version) || input.version < 1 || !migrationName.test(input.name)) throw new Error("Invalid plugin data migration");
      const existing = await client.query<{ version: number; name: string; applied_at: string }>("SELECT version, name, applied_at FROM carmediahub_plugin_data_migrations WHERE organization_id = $1 AND user_id = $2 AND installation_id = $3 AND version = $4", [organizationId, userId, installationId, input.version]);
      const row = existing.rows[0];
      if (row !== undefined) {
        if (row.name !== input.name) throw new Error("Plugin data migration version conflict");
        return { version: row.version, name: row.name, appliedAt: row.applied_at };
      }
      const appliedAt = new Date().toISOString();
      await client.query("INSERT INTO carmediahub_plugin_data_migrations (organization_id, user_id, installation_id, version, name, applied_at) VALUES ($1, $2, $3, $4, $5, $6)", [organizationId, userId, installationId, input.version, input.name, appliedAt]);
      return { version: input.version, name: input.name, appliedAt };
    },
    async migrations(): Promise<readonly PluginDataMigration[]> {
      const result = await client.query<{ version: number; name: string; applied_at: string }>("SELECT version, name, applied_at FROM carmediahub_plugin_data_migrations WHERE organization_id = $1 AND user_id = $2 AND installation_id = $3 ORDER BY version", [organizationId, userId, installationId]);
      return result.rows.map((row) => ({ version: row.version, name: row.name, appliedAt: row.applied_at }));
    }
  };
}

export function createPostgresPool(config: PoolConfig): Pool {
  // pg falls back to PG* environment variables when these fields are absent.
  // Reject incomplete config at the Core boundary so deployment behavior is explicit.
  const connectionString = typeof config.connectionString === "string" ? config.connectionString.trim() : "";
  const hasExplicitEndpoint = typeof config.host === "string" && config.host.trim().length > 0
    && typeof config.database === "string" && config.database.trim().length > 0
    && typeof config.user === "string" && config.user.trim().length > 0;
  if (connectionString.length === 0 && !hasExplicitEndpoint) {
    throw new Error("PostgreSQL requires an explicit connectionString or host/database/user configuration");
  }
  return new Pool(config);
}
