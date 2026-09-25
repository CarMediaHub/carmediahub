import type { DatabaseSync } from "node:sqlite";
import type { MysqlQueryClient } from "./mysql-data-service.js";
import { createMysqlPluginDataStore, deleteMysqlPluginData, ensureMysqlPluginDataSchema, exportMysqlPluginData } from "./mysql-data-service.js";
import type { PluginDataExport } from "./data-service.js";
import { createPluginDataStore, deletePluginData, exportPluginData } from "./data-service.js";
import type { PostgresQueryClient } from "./postgres-data-service.js";
import { createPostgresPluginDataStore, deletePostgresPluginData, ensurePostgresPluginDataSchema, exportPostgresPluginData } from "./postgres-data-service.js";
import type { PluginDataStore, ScopeContext } from "@carmediahub/sdk";

/**
 * Core-owned backend handle. This type is never serialized or passed to a
 * plugin; it only selects which adapter Core uses for a scoped logical store.
 */
export type PluginDataBackend =
  | { kind: "sqlite"; db: DatabaseSync }
  | { kind: "postgres"; client: PostgresQueryClient }
  | { kind: "mysql"; client: MysqlQueryClient };

export interface PluginDataProvider {
  readonly kind: PluginDataBackend["kind"];
  ensureSchema(): Promise<void>;
  store(scope: ScopeContext): PluginDataStore;
  export(scope: ScopeContext): Promise<PluginDataExport>;
  delete(scope: ScopeContext): Promise<number>;
}

/**
 * Creates one Core-owned provider. `store()` only returns the SDK logical
 * namespace; database connections, schema names and SQL remain private to
 * this module and its adapters.
 */
export function createPluginDataProvider(backend: PluginDataBackend): PluginDataProvider {
  if (backend.kind === "sqlite") {
    return {
      kind: backend.kind,
      ensureSchema: async () => undefined,
      store: (scope) => createPluginDataStore(backend.db, scope),
      export: async (scope) => exportPluginData(backend.db, scope),
      delete: async (scope) => deletePluginData(backend.db, scope)
    };
  }
  if (backend.kind === "postgres") {
    return {
      kind: backend.kind,
      ensureSchema: () => ensurePostgresPluginDataSchema(backend.client),
      store: (scope) => createPostgresPluginDataStore(backend.client, scope),
      export: (scope) => exportPostgresPluginData(backend.client, scope),
      delete: (scope) => deletePostgresPluginData(backend.client, scope)
    };
  }
  return {
    kind: backend.kind,
    ensureSchema: () => ensureMysqlPluginDataSchema(backend.client),
    store: (scope) => createMysqlPluginDataStore(backend.client, scope),
    export: (scope) => exportMysqlPluginData(backend.client, scope),
    delete: (scope) => deleteMysqlPluginData(backend.client, scope)
  };
}
