import { Pool, type PoolConfig, type QueryResultRow } from "pg";
import type { DataRecord, PluginDataStore, ScopeContext } from "@carmediahub/sdk";

const identifier = /^[a-z][a-z0-9_-]{0,63}$/u;

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
)`;

export async function ensurePostgresPluginDataSchema(client: PostgresQueryClient): Promise<void> {
  await client.query(POSTGRES_PLUGIN_DATA_SCHEMA);
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
