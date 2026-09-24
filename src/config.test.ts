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

test("ignores the package-manager separator before CLI options", () => {
  const config = parseConfig(["--", "--data-dir", "C:/cmh/data", "--port", "9081"], "C:/ignored");
  assert.equal(config.dataDir.replaceAll("\\", "/"), "C:/cmh/data");
  assert.equal(config.port, 9081);
});

test("production Core source does not read process environment variables", () => {
  const sourceRoot = path.resolve(process.cwd(), "src");
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const location = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(location);
      else if (entry.isFile() && location.endsWith(".ts") && !location.endsWith(".test.ts")) files.push(location);
    }
  };
  visit(sourceRoot);
  const offenders = files.filter((location) => {
    const source = fs.readFileSync(location, "utf8");
    return /(?:process\.env|Deno\.env|Bun\.env)/u.test(source);
  });
  assert.deepEqual(offenders, [], `production source must not read OS environment variables: ${offenders.join(", ")}`);
});

test("production Core source does not invoke shell or PATH-resolved system commands", () => {
  const sourceRoot = path.resolve(process.cwd(), "src");
  const offenders: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const location = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(location);
      else if (entry.isFile() && location.endsWith(".ts") && !location.endsWith(".test.ts")) {
        const source = fs.readFileSync(location, "utf8");
        if (/\bshell\s*:\s*true\b/u.test(source) || /\bspawn(?:Sync)?\(\s*["'](?:taskkill|systemctl|sc\.exe|useradd|install|chown)["']/u.test(source)) offenders.push(location);
      }
    }
  };
  visit(sourceRoot);
  assert.deepEqual(offenders, [], `production source must use explicit executable paths and shell:false: ${offenders.join(", ")}`);
});

test("rejects invalid or incomplete deployment options", () => {
  assert.throws(() => parseConfig(["--port", "0"]), /between 1 and 65535/);
  assert.throws(() => parseConfig(["--port", "70000"]), /between 1 and 65535/);
  assert.throws(() => parseConfig(["--host"]), /requires a valid value/);
  assert.throws(() => parseConfig(["--data-dir"]), /requires a value/);
  assert.throws(() => parseConfig(["--config", "one.json", "--config", "two.json"]), /only be specified once/);
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
  const cliRelative = parseConfig(["--data-dir", "cli-state"], root);
  assert.equal(cliRelative.dataDir.replaceAll("\\", "/"), `${root.replaceAll("\\", "/")}/cli-state`);
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

test("keeps the checked-in configuration schema aligned with the example", () => {
  const schemaPath = path.resolve(process.cwd(), "config", "core.schema.json");
  const examplePath = path.resolve(process.cwd(), "config", "core.example.json");
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as { properties?: Record<string, unknown>; additionalProperties?: boolean };
  const example = JSON.parse(fs.readFileSync(examplePath, "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), ["cookieSecure", "dataDir", "host", "port", "publicUrl"]);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(example).sort(), Object.keys(schema.properties ?? {}).sort());
  assert.equal("password" in example, false);
  assert.equal("token" in example, false);
});
