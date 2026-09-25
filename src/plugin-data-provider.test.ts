import assert from "node:assert/strict";
import test from "node:test";
import { createPluginDataProvider } from "./plugin-data-provider.js";

const scope = { deploymentId: "deployment", organizationId: "org", userId: "user", deviceId: "device", sessionId: "session", installationId: "plugin" } as const;

test("provider keeps backend connections private while exposing only a scoped logical store", async () => {
  const queries: string[] = [];
  const client = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.startsWith("SELECT version")) return [[], undefined];
      if (sql.startsWith("SELECT record_key")) return [[], undefined];
      return [[], undefined];
    }
  };
  const provider = createPluginDataProvider({ kind: "mysql", client });
  assert.equal(provider.kind, "mysql");
  await provider.ensureSchema();
  const store = provider.store(scope);
  assert.equal("client" in store, false);
  assert.deepEqual(await store.list("history"), []);
  assert.ok(queries.some((query) => query.includes("CREATE TABLE IF NOT EXISTS")));
  assert.ok(queries.every((query) => !query.includes("SHOW DATABASES")));
});

test("provider selects PostgreSQL adapter without changing the SDK surface", async () => {
  const queries: string[] = [];
  const client = {
    async query(text: string) {
      queries.push(text);
      return { rows: [], rowCount: 0 };
    }
  };
  const provider = createPluginDataProvider({ kind: "postgres", client });
  await provider.ensureSchema();
  const store = provider.store(scope);
  assert.equal(typeof store.get, "function");
  assert.equal(typeof store.migrate, "function");
  assert.ok(queries.some((query) => query.includes("CREATE TABLE IF NOT EXISTS")));
});
