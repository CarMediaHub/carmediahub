import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { componentExecutableName, currentPlatformKey, loadComponentCatalog, resolveManagedExecutable } from "./components.js";

test("loads the built-in component catalog without environment discovery", () => {
  const catalog = loadComponentCatalog(path.resolve(import.meta.dirname, ".."));
  assert.deepEqual(catalog.map((item) => item.id), ["alist", "rclone", "ffmpeg", "sevenzip", "mihomo"]);
  assert.ok(catalog[2]!.platforms.includes(currentPlatformKey()));
  assert.ok(resolveManagedExecutable("C:/cmh-data", catalog[2]!).endsWith(`components\\ffmpeg\\ffmpeg${process.platform === "win32" ? ".exe" : ""}`) || resolveManagedExecutable("C:/cmh-data", catalog[2]!).endsWith(`components/ffmpeg/ffmpeg${process.platform === "win32" ? ".exe" : ""}`));
  assert.equal(componentExecutableName(catalog[2]!), `ffmpeg${process.platform === "win32" ? ".exe" : ""}`);
});
