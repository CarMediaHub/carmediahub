import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "./app.js";
import { openDatabase } from "./database.js";

test("history and catalog HTTP pagination filters before applying the page", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-pagination-api-"));
  const app = await createApp({ dataDir });
  try {
    await app.inject({ method: "POST", url: "/api/bootstrap", payload: { username: "admin", password: "correct horse battery staple" } });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "correct horse battery staple" } });
    const cookie = login.headers["set-cookie"];
    const database = openDatabase(dataDir);
    const user = database.db.prepare("SELECT id, organization_id FROM users LIMIT 1").get() as { id: string; organization_id: string };
    database.db.prepare("INSERT INTO platform_history (id, organization_id, user_id, installation_id, subject_type, subject_id, plugin_id, route, title, category, visited_at, source_device) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "history_one", user.organization_id, user.id, "wdr", "media", "one", "wdr", "/one", "Road one", "video", "2026-01-01T00:00:01.000Z", "desktop",
      "history_other", user.organization_id, user.id, "wdr", "media", "other", "wdr", "/other", "Unrelated", "video", "2026-01-01T00:00:02.000Z", "desktop",
      "history_three", user.organization_id, user.id, "wdr", "media", "three", "wdr", "/three", "Road three", "video", "2026-01-01T00:00:03.000Z", "desktop"
    );
    database.db.prepare("INSERT INTO catalog_entries (id, organization_id, user_id, installation_id, subject_type, subject_id, plugin_id, title, category, route, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "catalog_one", user.organization_id, user.id, "wdr", "media", "one", "wdr", "Road one", "video", "/one", "2026-01-01T00:00:01.000Z",
      "catalog_other", user.organization_id, user.id, "wdr", "media", "other", "wdr", "Unrelated", "video", "/other", "2026-01-01T00:00:02.000Z",
      "catalog_three", user.organization_id, user.id, "wdr", "media", "three", "wdr", "Road three", "video", "/three", "2026-01-01T00:00:03.000Z"
    );
    database.close();
    const history = await app.inject({ method: "GET", url: "/api/history?keyword=road&limit=1&offset=1", headers: { cookie } });
    assert.equal(history.statusCode, 200);
    assert.equal(history.json().total, 2);
    assert.equal(history.json().entries.length, 1);
    const catalog = await app.inject({ method: "GET", url: "/api/catalog?keyword=road&limit=1&offset=1", headers: { cookie } });
    assert.equal(catalog.statusCode, 200);
    assert.equal(catalog.json().total, 2);
    assert.equal(catalog.json().entries.length, 1);
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
