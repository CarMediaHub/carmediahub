import test from "node:test";
import assert from "node:assert/strict";
import { createMigrationHelperName, parseDockerBackupArgs } from "./docker-backup-migrate.mjs";

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
  assert.throws(() => parseDockerBackupArgs(["restore", "--docker", dockerPath, "--container", "cmh-core", "--image", "registry/../core:latest", "--volume", "cmh-data", "--snapshot", "./snapshot"]), /image and volume names are invalid/u);
});

test("uses unique, scoped helper names for every migration", () => {
  const first = createMigrationHelperName("cmh-core", "restore");
  const second = createMigrationHelperName("cmh-core", "restore");
  assert.match(first, /^cmh-core-restore-[a-f0-9]{12}$/u);
  assert.match(second, /^cmh-core-restore-[a-f0-9]{12}$/u);
  assert.notEqual(first, second);
  assert.throws(() => createMigrationHelperName("cmh/core", "restore"), /helper identity is invalid/u);
  assert.throws(() => createMigrationHelperName("cmh-core", "destroy"), /helper identity is invalid/u);
});
