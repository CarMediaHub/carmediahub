import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateDeployment } from "./validate-deployment.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compose = fs.readFileSync(path.join(root, "compose.yaml"), "utf8");
const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");

test("accepts the checked-in hardened deployment profile", () => {
  assert.doesNotThrow(() => validateDeployment(compose, dockerfile));
});

test("rejects an auxiliary service and a public host port", () => {
  assert.throws(() => validateDeployment(`${compose.replace("services:\n  core:", "services:\n  postgres:\n    image: postgres\n  core:")}\n`, dockerfile), /Compose must define Core|auxiliary services/u);
});

test("rejects implicit environment and a non-Core entrypoint", () => {
  assert.throws(() => validateDeployment(compose, `${dockerfile}\nENV PATH=/usr/local/bin\nENTRYPOINT ["sh"]\n`), /implicit PATH|entrypoint/u);
});

test("rejects baking the whole configuration directory into the image", () => {
  assert.throws(() => validateDeployment(compose, dockerfile.replace("COPY carmediahub/config/components.json carmediahub/config/components.schema.json carmediahub/config/core.example.json ./carmediahub/config/", "COPY carmediahub/config ./carmediahub/config/")), /controlled configuration artifacts|whole configuration directory/u);
});
