import assert from "node:assert/strict";
import { createPostgresPluginDataStore, createPostgresPool, ensurePostgresPluginDataSchema } from "../dist/postgres-data-service.js";

function argument(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value === undefined || value.startsWith("--")) throw new Error(`Usage: postgres-smoke --connection-string <value>`);
  return value;
}

const pool = createPostgresPool({ connectionString: argument("--connection-string"), max: 2 });
try {
  await ensurePostgresPluginDataSchema(pool);
  const first = createPostgresPluginDataStore(pool, {
    deploymentId: "deployment",
    organizationId: "org",
    userId: "user-a",
    deviceId: "device",
    sessionId: "session",
    installationId: "plugin-a",
  });
  const second = createPostgresPluginDataStore(pool, {
    deploymentId: "deployment",
    organizationId: "org",
    userId: "user-b",
    deviceId: "device",
    sessionId: "session",
    installationId: "plugin-a",
  });
  await first.put("history", "one", { value: 1 });
  assert.deepEqual((await first.get("history", "one"))?.value, { value: 1 });
  assert.equal(await second.get("history", "one"), undefined);
  assert.equal((await first.list("history")).length, 1);
  assert.equal(await first.delete("history", "one"), true);
  assert.equal(await first.get("history", "one"), undefined);
} finally {
  await pool.end();
}

console.log("PostgreSQL adapter smoke passed.");
