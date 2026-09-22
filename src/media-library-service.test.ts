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
  fs.mkdirSync(path.join(root, "shows", "season-1"), { recursive: true });
  fs.writeFileSync(path.join(root, "shows", "season-1", "episode.mp4"), "episode");
  fs.writeFileSync(path.join(root, "note.txt"), "private");
  const external = path.join(root, "outside.mp4");
  try { fs.symlinkSync(path.join(root, "drive.mp4"), external); } catch { /* Symlinks may be unavailable on restricted Windows hosts. */ }
  const database = openDatabase(dataDir);
  try {
    database.db.prepare("INSERT INTO deployments (id, created_at, locale) VALUES ('deployment', 'now', 'en')").run();
    database.db.prepare("INSERT INTO organizations (id, deployment_id, name) VALUES ('org', 'deployment', 'Default')").run();
    database.db.prepare("INSERT INTO users (id, organization_id, username, password_hash, role, locale, created_at) VALUES ('user', 'org', 'user', 'hash', 'admin', 'en', 'now')").run();
    const service = new MediaLibraryService(database.db, Buffer.alloc(32, 1));
    const mediaRoot = service.addRoot("org", "plugin-a", "Road media", root);
    assert.deepEqual(service.roots("org"), [mediaRoot]);
    const items = service.list("org", "plugin-a", mediaRoot.id);
    assert.deepEqual(items.map((item) => ({ title: item.title, contentType: item.contentType, size: item.size })), [
      { title: "drive.mp4", contentType: "video/mp4", size: 5 },
      { title: "episode.mp4", contentType: "video/mp4", size: 7 }
    ]);
    assert.equal(Buffer.from(service.read("org", "plugin-a", items.find((item) => item.title === "episode.mp4")!.id, 0, 6).data, "base64").toString(), "episode");
    const scope = { organizationId: "org", userId: "user", deviceId: "vehicle-a", installationId: "plugin-a" };
    const playback = service.createPlayback(scope, items[0]!.id);
    assert.deepEqual(service.probe(scope, items[0]!.id), {
      mediaId: items[0]!.id,
      contentType: "video/mp4",
      size: 5,
      updatedAt: service.probe(scope, items[0]!.id).updatedAt,
      container: "mp4",
      seekable: true,
      availableModes: ["direct-range"],
      recommendedMode: "direct-range"
    });
    assert.equal(Buffer.from(service.readWithPlayback(scope, playback.sessionId, items[0]!.id, 0, 4).data, "base64").toString(), "video");
    assert.throws(() => service.readWithPlayback({ ...scope, deviceId: "vehicle-b" }, playback.sessionId, items[0]!.id, 0, 4), /unavailable/);
    service.revokePlaybackForUser("user");
    assert.throws(() => service.readWithPlayback(scope, playback.sessionId, items[0]!.id, 0, 4), /unavailable/);
    assert.equal(service.revoke("org", mediaRoot.id), true);
    assert.throws(() => service.list("org", "plugin-a", mediaRoot.id), /unavailable/);
  } finally { database.close(); fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); }
});

test("rejects a media root replaced by a directory link", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-media-data-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-media-root-"));
  const moved = `${root}-moved`;
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-media-outside-"));
  const database = openDatabase(dataDir);
  try {
    database.db.prepare("INSERT INTO deployments (id, created_at, locale) VALUES ('deployment', 'now', 'en')").run();
    database.db.prepare("INSERT INTO organizations (id, deployment_id, name) VALUES ('org', 'deployment', 'Default')").run();
    const service = new MediaLibraryService(database.db, Buffer.alloc(32, 1));
    const mediaRoot = service.addRoot("org", "plugin-a", "Road media", root);
    fs.renameSync(root, moved);
    try { fs.symlinkSync(outside, root, "junction"); } catch { return; }
    assert.throws(() => service.list("org", "plugin-a", mediaRoot.id), /unavailable/);
  } finally {
    database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(moved, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
