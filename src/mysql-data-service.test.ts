import assert from "node:assert/strict";
import test from "node:test";
import { createMysqlPluginDataStore, createMysqlPool, ensureMysqlPluginDataSchema, type MysqlQueryClient } from "./mysql-data-service.js";

const scope = { deploymentId: "dep", organizationId: "org", userId: "user", deviceId: "device", sessionId: "session", installationId: "plugin" } as const;

test("MySQL data adapter keeps scope and uses parameterized statements", async () => {
  const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  const client: MysqlQueryClient = { async query<T>(sql, values = []) { queries.push({ sql, values }); if (sql.startsWith("SELECT")) return [[{ record_key: "one", value_json: { ok: true }, updated_at: "2026-01-01T00:00:00.000Z" }] as T, {}]; if (sql.startsWith("DELETE")) return [{ affectedRows: 1 } as T, {}]; return [[] as T, {}]; } };
  await ensureMysqlPluginDataSchema(client);
  const store = createMysqlPluginDataStore(client, scope);
  await store.put("history", "one", { ok: true });
  assert.deepEqual((await store.get("history", "one"))?.value, { ok: true });
  assert.equal(await store.delete("history", "one"), true);
  assert.deepEqual(queries.find((query) => query.sql.startsWith("SELECT record_key"))?.values?.slice(0, 5), ["org", "user", "plugin", "history", "one"]);
  assert.ok(queries.every((query) => !query.sql.includes("${")));
});

test("MySQL adapter stores UTC DATETIME values and returns ISO timestamps", async () => {
  const writes: unknown[][] = [];
  const client: MysqlQueryClient = {
    async query<T>(sql, values = []) {
      if (sql.startsWith("SELECT version")) return [[] as T, {}];
      if (sql.startsWith("SELECT record_key")) return [[{ record_key: "one", value_json: { ok: true }, updated_at: "2026-01-01 00:00:00.123" }] as T, {}];
      writes.push([...values]);
      return [[] as T, {}];
    }
  };
  const store = createMysqlPluginDataStore(client, scope);
  const migration = await store.migrate({ version: 1, name: "initial" });
  const record = await store.put("history", "one", { ok: true });
  const loaded = await store.get("history", "one");
  assert.match(String(writes[0]?.[5]), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/u);
  assert.match(String(writes[1]?.[6]), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/u);
  assert.match(migration.appliedAt, /Z$/u);
  assert.match(record.updatedAt, /Z$/u);
  assert.equal(loaded?.updatedAt, "2026-01-01T00:00:00.123Z");
});

test("MySQL adapter rejects unsafe identifiers and undefined JSON", async () => {
  let calls = 0;
  const client: MysqlQueryClient = { async query() { calls += 1; return [[], {}]; } };
  const store = createMysqlPluginDataStore(client, scope);
  await assert.rejects(() => store.get("History", "key"));
  await assert.rejects(() => store.list("history", { prefix: "bad/prefix" }));
  await assert.rejects(() => store.put("history", "missing", undefined), /JSON serializable/);
  assert.equal(calls, 0);
});

test("MySQL pool requires explicit endpoint fields and ignores implicit defaults", () => {
  assert.throws(() => createMysqlPool({}), /explicit host/);
  const pool = createMysqlPool({ host: "db.example", user: "cmh", database: "cmh", port: 3307 });
  assert.ok(pool);
  assert.throws(() => createMysqlPool({ host: "db.example", user: "cmh", database: "cmh", port: 0 }), /port is invalid/);
  void pool.end();
});
