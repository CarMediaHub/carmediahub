import assert from "node:assert/strict";
import test from "node:test";
import { BrowserTargetRegistry } from "./browser-target-registry.js";

test("browser target registry stores logical IDs and normalized HTTPS origins", () => {
  const registry = new BrowserTargetRegistry();
  registry.register({ id: "media.example", origins: ["https://media.example:443"] });
  assert.deepEqual(registry.get("media.example"), { id: "media.example", origins: ["https://media.example"] });
  assert.equal(registry.allowsOrigin("media.example", "https://media.example/"), true);
  assert.equal(registry.allowsOrigin("media.example", "https://other.example"), false);
  const copy = registry.get("media.example")!;
  (copy.origins as string[]).push("https://other.example");
  assert.equal(registry.allowsOrigin("media.example", "https://other.example"), false);
});

test("browser target registry rejects unsafe origins and duplicate targets", () => {
  const registry = new BrowserTargetRegistry();
  assert.throws(() => registry.register({ id: "unsafe", origins: ["http://localhost:3000"] }), /origin is invalid/);
  assert.throws(() => registry.register({ id: "unsafe", origins: ["https://user:pass@example.com"] }), /origin is invalid/);
  assert.throws(() => registry.register({ id: "unsafe", origins: ["https://example.com/path"] }), /origin is invalid/);
  registry.register({ id: "safe", origins: ["https://example.com"] });
  assert.throws(() => registry.register({ id: "safe", origins: ["https://other.example"] }), /already registered/);
  assert.equal(registry.allowsOrigin("missing", "https://example.com"), false);
});
