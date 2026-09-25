import assert from "node:assert/strict";
import { createMysqlPluginDataStore, createMysqlPool, deleteMysqlPluginData, ensureMysqlPluginDataSchema, exportMysqlPluginData } from "../dist/mysql-data-service.js";

function argument(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value === undefined || value.startsWith("--")) throw new Error(`Usage: mysql-smoke --host <host> --port <port> --user <user> --password <password> --database <database>`);
  return value;
}

const pool = createMysqlPool({ host: argument("--host"), port: Number(argument("--port")), user: argument("--user"), password: argument("--password"), database: argument("--database"), connectionLimit: 2 });
const firstScope = { deploymentId: "deployment", organizationId: "org", userId: "user-a", deviceId: "device", sessionId: "session", installationId: "plugin-a" };
const secondScope = { ...firstScope, userId: "user-b" };
try {
  await ensureMysqlPluginDataSchema(pool);
  const first = createMysqlPluginDataStore(pool, firstScope);
  const second = createMysqlPluginDataStore(pool, secondScope);
  await first.migrate({ version: 1, name: "initial" });
  await first.put("history", "one", { value: 1 });
  assert.deepEqual((await first.get("history", "one"))?.value, { value: 1 });
  assert.equal(await second.get("history", "one"), undefined);
  assert.deepEqual((await first.migrations()).map((migration) => migration.name), ["initial"]);
  assert.equal((await exportMysqlPluginData(pool, firstScope)).collections[0]?.records.length, 1);
  assert.equal(await deleteMysqlPluginData(pool, firstScope), 1);
  assert.equal(await first.get("history", "one"), undefined);
} finally {
  await pool.end();
}

console.log("MySQL adapter smoke passed.");
