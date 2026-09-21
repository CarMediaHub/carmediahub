import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresPluginDataStore, ensurePostgresPluginDataSchema, type PostgresQueryClient } from "./postgres-data-service.js";

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
