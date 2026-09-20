import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { loadComponentCatalog, resolveManagedExecutable } from "./components.js";

test("loads the built-in component catalog without environment discovery", () => {
  const catalog = loadComponentCatalog(path.resolve(import.meta.dirname, ".."));
  assert.deepEqual(catalog.map((item) => item.id), ["alist", "rclone", "ffmpeg", "sevenzip", "mihomo"]);
  assert.ok(resolveManagedExecutable("C:/cmh-data", catalog[2]!).endsWith("components\\ffmpeg\\ffmpeg") || resolveManagedExecutable("C:/cmh-data", catalog[2]!).endsWith("components/ffmpeg/ffmpeg"));
});
