import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "./database.js";
import { Repository } from "./repository.js";
import { ensureServerKey } from "./security.js";

test("service bindings are scoped to the declared plugin installation", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-binding-scope-"));
  const database = openDatabase(dataDir);
  try {
    const repository = new Repository(database.db, ensureServerKey(dataDir));
    repository.bootstrap("admin", "correct horse battery staple", "en");
    repository.registerComponent({ id: "alist", version: "1.0.0", executable: "alist/alist", checksum: "sha256:test" });
    const manifest = { id: "adapter-one", version: "0.1.0", sdk: "^0.1.0", name: { en: "Adapter", "zh-CN": "适配器", ko: "어댑터" }, description: { en: "Adapter", "zh-CN": "适配器", ko: "어댑터" }, category: "adapter", runtime: "isolated-worker", capabilities: ["network"], routes: [{ path: "/", methods: ["GET"] }], worker: { entry: "./worker.js", protocol: "0.1" } } as const;
    const installation = repository.installPlugin(manifest);
    repository.bindService({ componentId: "alist", name: "adapter-one-service", endpoint: "http://127.0.0.1:5244", installationId: installation.id });
    assert.deepEqual(repository.serviceBindingByName("adapter-one-service", installation.id), { endpoint: "http://127.0.0.1:5244/" });
    assert.equal(repository.serviceBindingByName("adapter-one-service", "plugin_other"), undefined);
    assert.throws(() => repository.bindService({ componentId: "alist", name: "disabled-service", endpoint: "http://127.0.0.1:5244", installationId: "plugin_missing" }));
  } finally { database.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});
