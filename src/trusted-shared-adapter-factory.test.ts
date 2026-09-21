import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTrustedSharedAdapterFactory } from "./trusted-shared-adapter-factory.js";

test("trusted shared adapter factory loads only the explicit package entry", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-shared-adapter-"));
  fs.writeFileSync(path.join(root, "adapter.mjs"), "export {};");
  let received: unknown;
  try {
    const factory = createTrustedSharedAdapterFactory({ packageId: "shared-adapter-example", packageRoot: root, runtimeEntry: "./adapter.mjs" }, async (url) => {
      assert.match(url, /adapter\.mjs$/u);
      return { startWorker: async (options: unknown) => { received = options; return { stop() {} }; } };
    });
    const handle = await factory.start({ installationId: "installation", endpoint: "broker", runtimeCredential: "credential", scope: {} as never });
    assert.deepEqual(received, { endpoint: "broker", installationId: "installation", runtimeCredential: "credential" });
    handle.stop();
    assert.throws(() => createTrustedSharedAdapterFactory({ packageId: "shared-adapter-example", packageRoot: root, runtimeEntry: "../adapter.mjs" }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
