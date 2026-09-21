import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "./database.js";
import { MediaLibraryService } from "./media-library-service.js";

test("managed media roots hide paths and ignore links or unsupported files", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-media-data-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-media-root-"));
  fs.writeFileSync(path.join(root, "drive.mp4"), "video");
  fs.writeFileSync(path.join(root, "note.txt"), "private");
  const external = path.join(root, "outside.mp4");
  try { fs.symlinkSync(path.join(root, "drive.mp4"), external); } catch { /* Symlinks may be unavailable on restricted Windows hosts. */ }
  const database = openDatabase(dataDir);
  try {
    database.db.prepare("INSERT INTO deployments (id, created_at, locale) VALUES ('deployment', 'now', 'en')").run();
    database.db.prepare("INSERT INTO organizations (id, deployment_id, name) VALUES ('org', 'deployment', 'Default')").run();
    const service = new MediaLibraryService(database.db, Buffer.alloc(32, 1));
    const mediaRoot = service.addRoot("org", "Road media", root);
    assert.deepEqual(service.roots("org"), [mediaRoot]);
    assert.deepEqual(service.list("org", mediaRoot.id).map((item) => ({ title: item.title, contentType: item.contentType, size: item.size })), [{ title: "drive.mp4", contentType: "video/mp4", size: 5 }]);
    assert.equal(service.revoke("org", mediaRoot.id), true);
    assert.throws(() => service.list("org", mediaRoot.id), /unavailable/);
  } finally { database.close(); fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); }
});
