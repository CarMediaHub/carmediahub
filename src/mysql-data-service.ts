import { createPool, type Pool, type PoolOptions, type RowDataPacket } from "mysql2/promise";
import type { DataRecord, PluginDataMigration, PluginDataStore, ScopeContext } from "@carmediahub/sdk";
import { MAX_PLUGIN_DATA_EXPORT_BYTES, MAX_PLUGIN_DATA_EXPORT_RECORDS, type PluginDataExport } from "./data-service.js";

const identifier = /^[a-z][a-z0-9_-]{0,63}$/u;
const migrationName = /^[a-z][a-z0-9_.-]{0,127}$/u;
const escapeLikePrefix = (value: string): string => value.replace(/[!%_]/gu, "!$&");

// MySQL DATETIME has no timezone and rejects the RFC 3339 `Z` suffix. Keep
// storage in UTC with millisecond precision, while exposing the SDK's ISO form.
function mysqlDateTime(date = new Date()): string {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

function isoDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  const parsed = new Date(/^[0-9]{4}-[0-9]{2}-[0-9]{2} /.test(text) ? `${text.replace(" ", "T")}Z` : text);
  return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString();
}

function assertIdentifier(value: string, field: string): void {
  if (!identifier.test(value)) throw new Error(`${field} must be a lowercase identifier`);
}

function scopeValues(scope: ScopeContext): [string, string, string] {
  assertIdentifier(scope.organizationId, "organizationId");
  assertIdentifier(scope.userId, "userId");
  assertIdentifier(scope.installationId, "installationId");
  return [scope.organizationId, scope.userId, scope.installationId];
}

export interface MysqlQueryClient {
  query<T extends RowDataPacket[] = RowDataPacket[]>(sql: string, values?: readonly unknown[]): Promise<[T, unknown]>;
}

export const MYSQL_PLUGIN_DATA_SCHEMA = `
CREATE TABLE IF NOT EXISTS carmediahub_plugin_data (
  organization_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  installation_id VARCHAR(64) NOT NULL,
  collection VARCHAR(64) NOT NULL,
  record_key VARCHAR(64) NOT NULL,
  value_json JSON NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (organization_id, user_id, installation_id, collection, record_key)
);
CREATE TABLE IF NOT EXISTS carmediahub_plugin_data_migrations (
  organization_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  installation_id VARCHAR(64) NOT NULL,
  version INT NOT NULL,
  name VARCHAR(128) NOT NULL,
  applied_at DATETIME(3) NOT NULL,
  PRIMARY KEY (organization_id, user_id, installation_id, version)
)`;

export async function ensureMysqlPluginDataSchema(client: MysqlQueryClient): Promise<void> {
  for (const statement of MYSQL_PLUGIN_DATA_SCHEMA.split(";\n").map((value) => value.trim()).filter(Boolean)) await client.query(statement);
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { throw new Error("MySQL plugin data contains invalid JSON"); }
}

export async function exportMysqlPluginData(client: MysqlQueryClient, scope: ScopeContext): Promise<PluginDataExport> {
  const [organizationId, userId, installationId] = scopeValues(scope);
  const [rows] = await client.query<Array<RowDataPacket & { collection: string; record_key: string; value_json: unknown; updated_at: string }>>(
    "SELECT collection, record_key, value_json, updated_at FROM carmediahub_plugin_data WHERE organization_id = ? AND user_id = ? AND installation_id = ? ORDER BY collection, record_key LIMIT ?",
    [organizationId, userId, installationId, MAX_PLUGIN_DATA_EXPORT_RECORDS + 1]
  );
  if (rows.length > MAX_PLUGIN_DATA_EXPORT_RECORDS) throw new Error("Plugin data export exceeds record limit");
  const grouped = new Map<string, DataRecord[]>();
  for (const row of rows) { const records = grouped.get(row.collection) ?? []; records.push({ key: row.record_key, value: jsonValue(row.value_json), updatedAt: isoDate(row.updated_at) }); grouped.set(row.collection, records); }
  const [migrations] = await client.query<Array<RowDataPacket & { version: number; name: string; applied_at: string }>>(
    "SELECT version, name, applied_at FROM carmediahub_plugin_data_migrations WHERE organization_id = ? AND user_id = ? AND installation_id = ? ORDER BY version",
    [organizationId, userId, installationId]
  );
  const result: PluginDataExport = { exportedAt: new Date().toISOString(), scope: { organizationId, userId, installationId }, migrations: migrations.map((row) => ({ version: row.version, name: row.name, appliedAt: isoDate(row.applied_at) })), collections: [...grouped.entries()].map(([name, records]) => ({ name, records })) };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_PLUGIN_DATA_EXPORT_BYTES) throw new Error("Plugin data export exceeds byte limit");
  return result;
}

export async function deleteMysqlPluginData(client: MysqlQueryClient, scope: ScopeContext): Promise<number> {
  const [organizationId, userId, installationId] = scopeValues(scope);
  await client.query("START TRANSACTION");
  try {
    const [result] = await client.query("DELETE FROM carmediahub_plugin_data WHERE organization_id = ? AND user_id = ? AND installation_id = ?", [organizationId, userId, installationId]) as [{ affectedRows?: number }, unknown];
    await client.query("DELETE FROM carmediahub_plugin_data_migrations WHERE organization_id = ? AND user_id = ? AND installation_id = ?", [organizationId, userId, installationId]);
    await client.query("COMMIT");
    return Number(result.affectedRows ?? 0);
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
}

export function createMysqlPluginDataStore(client: MysqlQueryClient, scope: ScopeContext): PluginDataStore {
  const [organizationId, userId, installationId] = scopeValues(scope);
  const address = (collection: string, key?: string) => { assertIdentifier(collection, "collection"); if (key !== undefined) assertIdentifier(key, "key"); return key === undefined ? [organizationId, userId, installationId, collection] : [organizationId, userId, installationId, collection, key]; };
  return {
    async get<T>(collection: string, key: string) { const values = address(collection, key); const [rows] = await client.query<Array<RowDataPacket & { record_key: string; value_json: unknown; updated_at: string }>>("SELECT record_key, value_json, updated_at FROM carmediahub_plugin_data WHERE organization_id = ? AND user_id = ? AND installation_id = ? AND collection = ? AND record_key = ?", values); const row = rows[0]; return row === undefined ? undefined : { key: row.record_key, value: jsonValue(row.value_json) as T, updatedAt: isoDate(row.updated_at) }; },
    async put<T>(collection: string, key: string, value: T) { const values = address(collection, key); const valueJson = JSON.stringify(value); if (valueJson === undefined) throw new Error("Plugin data value must be JSON serializable"); const updatedAt = new Date(); await client.query("INSERT INTO carmediahub_plugin_data (organization_id, user_id, installation_id, collection, record_key, value_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE value_json = VALUES(value_json), updated_at = VALUES(updated_at)", [...values, valueJson, mysqlDateTime(updatedAt)]); return { key, value, updatedAt: updatedAt.toISOString() }; },
    async delete(collection: string, key: string) { const values = address(collection, key); const [result] = await client.query("DELETE FROM carmediahub_plugin_data WHERE organization_id = ? AND user_id = ? AND installation_id = ? AND collection = ? AND record_key = ?", values) as [{ affectedRows?: number }, unknown]; return Number(result.affectedRows ?? 0) > 0; },
    async list<T>(collection: string, options: { prefix?: string; limit?: number } = {}) { assertIdentifier(collection, "collection"); const prefix = options.prefix ?? ""; if (prefix.length > 0) assertIdentifier(prefix, "prefix"); const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000); const [rows] = await client.query<Array<RowDataPacket & { record_key: string; value_json: unknown; updated_at: string }>>("SELECT record_key, value_json, updated_at FROM carmediahub_plugin_data WHERE organization_id = ? AND user_id = ? AND installation_id = ? AND collection = ? AND record_key LIKE ? ESCAPE '!' ORDER BY record_key LIMIT ?", [organizationId, userId, installationId, collection, `${escapeLikePrefix(prefix)}%`, limit]); return rows.map((row) => ({ key: row.record_key, value: jsonValue(row.value_json) as T, updatedAt: isoDate(row.updated_at) })); },
    async migrate(input: { version: number; name: string }) { if (!Number.isSafeInteger(input.version) || input.version < 1 || !migrationName.test(input.name)) throw new Error("Invalid plugin data migration"); const [rows] = await client.query<Array<RowDataPacket & { version: number; name: string; applied_at: string }>>("SELECT version, name, applied_at FROM carmediahub_plugin_data_migrations WHERE organization_id = ? AND user_id = ? AND installation_id = ? AND version = ?", [organizationId, userId, installationId, input.version]); const row = rows[0]; if (row !== undefined) { if (row.name !== input.name) throw new Error("Plugin data migration version conflict"); return { version: row.version, name: row.name, appliedAt: isoDate(row.applied_at) }; } const appliedAt = new Date(); await client.query("INSERT INTO carmediahub_plugin_data_migrations (organization_id, user_id, installation_id, version, name, applied_at) VALUES (?, ?, ?, ?, ?, ?)", [organizationId, userId, installationId, input.version, input.name, mysqlDateTime(appliedAt)]); return { version: input.version, name: input.name, appliedAt: appliedAt.toISOString() }; },
    async migrateBatch(inputs: readonly { version: number; name: string }[]) { if (!Array.isArray(inputs) || inputs.length > 100) throw new Error("Invalid plugin data migration batch"); await client.query("START TRANSACTION"); try { const result: PluginDataMigration[] = []; for (const input of inputs) result.push(await this.migrate(input)); await client.query("COMMIT"); return result; } catch (error) { await client.query("ROLLBACK"); throw error; } },
    async migrations() { const [rows] = await client.query<Array<RowDataPacket & { version: number; name: string; applied_at: string }>>("SELECT version, name, applied_at FROM carmediahub_plugin_data_migrations WHERE organization_id = ? AND user_id = ? AND installation_id = ? ORDER BY version", [organizationId, userId, installationId]); return rows.map((row) => ({ version: row.version, name: row.name, appliedAt: isoDate(row.applied_at) })); }
  };
}

export function createMysqlPool(config: PoolOptions): Pool {
  const host = typeof config.host === "string" ? config.host.trim() : "";
  const user = typeof config.user === "string" ? config.user.trim() : "";
  const database = typeof config.database === "string" ? config.database.trim() : "";
  if (host.length === 0 || user.length === 0 || database.length === 0) throw new Error("MySQL requires explicit host, user, and database configuration");
  const port = config.port ?? 3306;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("MySQL port is invalid");
  return createPool({ ...config, host, user, database, port, password: config.password ?? "", ...(config.ssl === undefined ? {} : { ssl: config.ssl }) });
}
