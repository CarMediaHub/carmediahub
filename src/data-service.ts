import type { DatabaseSync } from "node:sqlite";
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

/** Core-side adapter for the SDK's scoped logical data contract. */
export function createPluginDataStore(db: DatabaseSync, scope: ScopeContext): PluginDataStore {
  const [organizationId, userId, installationId] = scopeValues(scope);
  const address = (collection: string, key: string) => {
    assertIdentifier(collection, "collection");
    assertIdentifier(key, "key");
    return [organizationId, userId, installationId, collection, key] as const;
  };
  return {
    async get<T>(collection: string, key: string): Promise<DataRecord<T> | undefined> {
      const [org, user, installation, name, recordKey] = address(collection, key);
      const row = db.prepare("SELECT value_json, updated_at FROM plugin_data WHERE organization_id = ? AND user_id = ? AND installation_id = ? AND collection = ? AND record_key = ?")
        .get(org, user, installation, name, recordKey) as { value_json: string; updated_at: string } | undefined;
      return row === undefined ? undefined : { key, value: JSON.parse(row.value_json) as T, updatedAt: row.updated_at };
    },
    async put<T>(collection: string, key: string, value: T): Promise<DataRecord<T>> {
      const [org, user, installation, name, recordKey] = address(collection, key);
      const valueJson = JSON.stringify(value);
      if (valueJson === undefined) throw new Error("Plugin data value must be JSON serializable");
      const updatedAt = new Date().toISOString();
      db.prepare(`INSERT INTO plugin_data (organization_id, user_id, installation_id, collection, record_key, value_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(organization_id, user_id, installation_id, collection, record_key)
        DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
        .run(org, user, installation, name, recordKey, valueJson, updatedAt);
      return { key, value, updatedAt };
    },
    async delete(collection: string, key: string): Promise<boolean> {
      const [org, user, installation, name, recordKey] = address(collection, key);
      return db.prepare("DELETE FROM plugin_data WHERE organization_id = ? AND user_id = ? AND installation_id = ? AND collection = ? AND record_key = ?")
        .run(org, user, installation, name, recordKey).changes > 0;
    },
    async list<T>(collection: string, options: { prefix?: string; limit?: number } = {}): Promise<readonly DataRecord<T>[]> {
      assertIdentifier(collection, "collection");
      const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
      const prefix = options.prefix ?? "";
      if (prefix.length > 0) assertIdentifier(prefix, "prefix");
      return (db.prepare(`SELECT record_key, value_json, updated_at FROM plugin_data
        WHERE organization_id = ? AND user_id = ? AND installation_id = ? AND collection = ? AND record_key LIKE ?
        ORDER BY record_key LIMIT ?`).all(organizationId, userId, installationId, collection, `${prefix}%`, limit) as Array<{ record_key: string; value_json: string; updated_at: string }>)
        .map((row) => ({ key: row.record_key, value: JSON.parse(row.value_json) as T, updatedAt: row.updated_at }));
    }
  };
}
