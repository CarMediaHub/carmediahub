import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installStagedPluginPackage } from "./plugin-package-installer.js";

function digest(root: string): string {
  const files = ["ui/index.html", "worker.js"];
  const hash = crypto.createHash("sha256");
  for (const file of files) hash.update(`${file}\0${crypto.createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex")}\n`, "utf8");
  return hash.digest("hex");
}

test("installs only an exact verified plugin package from Core staging", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-plugin-package-"));
  const source = path.join(dataDir, "staging", "plugins", "wdr-build");
  fs.mkdirSync(path.join(source, "ui"), { recursive: true });
  fs.writeFileSync(path.join(source, "worker.js"), "export {};\n");
  fs.writeFileSync(path.join(source, "ui", "index.html"), "<main></main>\n");
  try {
    const installed = installStagedPluginPackage(dataDir, { packageId: "wdr-media", version: "0.1.0", artifactId: "wdr-build", digest: digest(source) });
    assert.equal(fs.readFileSync(path.join(dataDir, installed.location, "worker.js"), "utf8"), "export {};\n");
    assert.throws(() => installStagedPluginPackage(dataDir, { packageId: "wdr-media", version: "0.1.0", artifactId: "../wdr-build", digest: installed.digest }));
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});
