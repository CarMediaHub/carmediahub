import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresPluginDataStore, createPostgresPool, deletePostgresPluginData, ensurePostgresPluginDataSchema, exportPostgresPluginData, type PostgresQueryClient } from "./postgres-data-service.js";

test("PostgreSQL data adapter keeps scope in every parameterized operation", async () => {
  const queries: Array<{ text: string; values: readonly unknown[] }> = [];
  const client: PostgresQueryClient = {
    async query<T>(text: string, values: readonly unknown[] = []) {
      queries.push({ text, values });
      return { rows: text.startsWith("SELECT") ? [{ record_key: "one", value_json: { ok: true }, updated_at: "2026-01-01T00:00:00.000Z" } as T] : [], rowCount: text.startsWith("DELETE") ? 1 : 0 };
    }
  };
  await ensurePostgresPluginDataSchema(client);
  const store = createPostgresPluginDataStore(client, { deploymentId: "dep", organizationId: "org", userId: "user", deviceId: "device", sessionId: "session", installationId: "plugin" });
  await store.put("history", "one", { ok: true });
  assert.deepEqual((await store.get("history", "one"))?.value, { ok: true });
  assert.equal(await store.delete("history", "one"), true);
  assert.ok(queries.every((query) => !query.text.includes("${")));
  assert.deepEqual(queries[1]?.values?.slice(0, 5), ["org", "user", "plugin", "history", "one"]);
});

test("PostgreSQL data adapter rejects unsafe logical identifiers", async () => {
  const client: PostgresQueryClient = { async query() { return { rows: [], rowCount: 0 }; } };
  const store = createPostgresPluginDataStore(client, { deploymentId: "dep", organizationId: "org", userId: "user", deviceId: "device", sessionId: "session", installationId: "plugin" });
  await assert.rejects(() => store.get("History", "key"));
  await assert.rejects(() => store.list("history", { prefix: "bad/prefix" }));
});

test("PostgreSQL pool rejects incomplete config instead of reading PG* environment variables", () => {
  assert.throws(() => createPostgresPool({}), /explicit connectionString/);
  const pool = createPostgresPool({ host: "127.0.0.1", port: 5432, database: "cmh", user: "cmh" });
  void pool.end();
});

test("PostgreSQL plugin data export and deletion preserve scope and transaction boundaries", async () => {
  const queries: Array<{ text: string; values: readonly unknown[] }> = [];
  const client: PostgresQueryClient = {
    async query<T>(text: string, values: readonly unknown[] = []) {
      queries.push({ text, values });
      if (text.startsWith("SELECT collection")) return { rows: [{ collection: "settings", record_key: "layout", value_json: { compact: true }, updated_at: "2026-01-01T00:00:00.000Z" } as T], rowCount: 1 };
      if (text.startsWith("SELECT version")) return { rows: [{ version: 1, name: "initial", applied_at: "2026-01-01T00:00:00.000Z" } as T], rowCount: 1 };
      if (text.startsWith("DELETE FROM carmediahub_plugin_data")) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
  };
  const scope = { deploymentId: "dep", organizationId: "org", userId: "user", deviceId: "device", sessionId: "session", installationId: "plugin" } as const;
  const exported = await exportPostgresPluginData(client, scope);
  assert.deepEqual(exported.collections[0]?.records[0]?.value, { compact: true });
  assert.equal(await deletePostgresPluginData(client, scope), 1);
  assert.deepEqual(queries.slice(-4).map((query) => query.text), ["BEGIN", "DELETE FROM carmediahub_plugin_data WHERE organization_id = $1 AND user_id = $2 AND installation_id = $3", "DELETE FROM carmediahub_plugin_data_migrations WHERE organization_id = $1 AND user_id = $2 AND installation_id = $3", "COMMIT"]);
  assert.deepEqual(queries.find((query) => query.text.startsWith("SELECT collection"))?.values, ["org", "user", "plugin", 10001]);
});
