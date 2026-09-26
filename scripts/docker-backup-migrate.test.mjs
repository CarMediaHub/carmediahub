import test from "node:test";
import assert from "node:assert/strict";
import { parseDockerBackupArgs } from "./docker-backup-migrate.mjs";

const dockerPath = process.execPath;

test("parses an explicit export without environment discovery", () => {
  const command = parseDockerBackupArgs(["export", "--docker", dockerPath, "--container", "cmh-core", "--output", "./snapshot"]);
  assert.equal(command.action, "export");
  assert.equal(command.container, "cmh-core");
  assert.match(command.output, /snapshot$/u);
});

test("parses an explicit restore volume and image", () => {
  const command = parseDockerBackupArgs(["restore", "--docker", dockerPath, "--container", "cmh-core", "--image", "carmediahub-core:latest", "--volume", "cmh-data", "--snapshot", "./snapshot"]);
  assert.deepEqual({ action: command.action, container: command.container, image: command.image, volume: command.volume }, { action: "restore", container: "cmh-core", image: "carmediahub-core:latest", volume: "cmh-data" });
});

test("rejects implicit or unsafe Docker targets", () => {
  assert.throws(() => parseDockerBackupArgs(["export", "--docker", dockerPath, "--container", "cmh/core", "--output", "./snapshot"]), /container name is invalid/u);
  assert.throws(() => parseDockerBackupArgs(["restore", "--docker", dockerPath, "--container", "cmh-core", "--image", "core image", "--volume", "cmh-data", "--snapshot", "./snapshot"]), /image and volume names are invalid/u);
  assert.throws(() => parseDockerBackupArgs(["export", "--docker", dockerPath, "--container", "cmh-core", "--output", "./snapshot", "--volume", "cmh-data"]), /does not accept/u);
  assert.throws(() => parseDockerBackupArgs(["export", "--container", "cmh-core", "--output", "./snapshot"]), /--docker requires/u);
});
