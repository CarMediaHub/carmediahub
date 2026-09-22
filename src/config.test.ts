import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

test("loads an explicit JSON configuration and lets CLI values override it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-config-"));
  fs.mkdirSync(path.join(root, "config"));
  fs.writeFileSync(path.join(root, "config", "core.json"), JSON.stringify({ dataDir: "state", host: "0.0.0.0", port: 9000, publicUrl: "https://hub.example.test", cookieSecure: false }));
  const config = parseConfig(["--config", "config/core.json", "--port", "9001", "--no-cookie-secure"], root);
  assert.equal(config.dataDir.replaceAll("\\", "/"), `${root.replaceAll("\\", "/")}/state`);
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 9001);
  assert.equal(config.publicUrl, "https://hub.example.test");
  assert.equal(config.cookieSecure, false);
});

test("rejects unknown or invalid configuration file fields", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-config-"));
  const configPath = path.join(root, "core.json");
  fs.writeFileSync(configPath, JSON.stringify({ secret: "must-not-be-configured" }));
  assert.throws(() => parseConfig(["--config", configPath], root), /Unknown configuration field/);
  fs.writeFileSync(configPath, JSON.stringify({ publicUrl: "https://hub.example.test/path" }));
  assert.throws(() => parseConfig(["--config", configPath], root), /credential-free/);
  fs.writeFileSync(configPath, JSON.stringify({ publicUrl: null }));
  assert.throws(() => parseConfig(["--config", configPath], root), /requires a value/);
  assert.throws(() => parseConfig(["--config", path.join(root, "missing.json")], root), /does not exist/);
});
