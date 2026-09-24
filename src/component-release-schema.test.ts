import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("component release schema mirrors the signed release contract", () => {
  const schema = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "config", "component-release.schema.json"), "utf8")) as {
    required?: string[];
    additionalProperties?: boolean;
    properties?: Record<string, { $ref?: string }>;
    $defs?: Record<string, { required?: string[]; additionalProperties?: boolean; properties?: Record<string, unknown> }>;
  };
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["release", "signature"]);
  assert.equal(schema.properties?.release?.$ref, "#/$defs/release");
  assert.equal(schema.properties?.signature?.$ref, undefined);
  assert.deepEqual(schema.$defs?.release?.required, ["schemaVersion", "keyId", "componentId", "version", "artifactId", "sha256", "platform"]);
  assert.equal(schema.$defs?.release?.additionalProperties, false);
  assert.deepEqual(schema.$defs?.provenance?.required, ["sourceUrl", "licenseSpdx"]);
  assert.equal(schema.$defs?.provenance?.additionalProperties, false);
});
