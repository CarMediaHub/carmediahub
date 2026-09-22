import assert from "node:assert/strict";
import test from "node:test";
import { listeningAddress, parseConfig } from "./config.js";

test("uses explicit configuration rather than environment variables", () => {
  const config = parseConfig(["--data-dir", "C:/cmh/data", "--host", "0.0.0.0", "--port", "9080", "--public-url", "https://hub.example.test"], "C:/ignored");
  assert.equal(config.dataDir.replaceAll("\\", "/"), "C:/cmh/data");
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 9080);
  assert.equal(config.publicUrl, "https://hub.example.test");
  assert.equal(config.cookieSecure, true);
  assert.equal(listeningAddress(config), "https://hub.example.test");
  assert.equal(listeningAddress(parseConfig([])), "http://127.0.0.1:8787");
  assert.equal(parseConfig(["--cookie-secure"]).cookieSecure, true);
});

test("rejects invalid or incomplete deployment options", () => {
  assert.throws(() => parseConfig(["--port", "0"]), /between 1 and 65535/);
  assert.throws(() => parseConfig(["--port", "70000"]), /between 1 and 65535/);
  assert.throws(() => parseConfig(["--host"]), /requires a valid value/);
  assert.throws(() => parseConfig(["--data-dir"]), /requires a value/);
  assert.throws(() => parseConfig(["--unknown"]), /Unknown option/);
  assert.throws(() => parseConfig(["--public-url", "https://user:pass@example.test"]), /credential-free/);
});
