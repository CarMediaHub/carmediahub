import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const namePattern = /^[a-z0-9][a-z0-9_.-]{0,127}$/u;
const imagePattern = /^[a-zA-Z0-9][a-zA-Z0-9._\/-]{0,126}(?::[a-zA-Z0-9][a-zA-Z0-9._-]{0,31})?$/u;

function fail(message) { throw new Error(`Docker backup migration failed: ${message}`); }

function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || args[index + 1] === undefined || args[index + 1].startsWith("--")) fail(`${name} requires a value`);
  return args[index + 1];
}

function executablePath(args) {
  const value = path.resolve(option(args, "--docker"));
  if (!path.isAbsolute(value) || !fs.existsSync(value) || !fs.statSync(value).isFile()) fail("--docker must be an existing absolute executable path");
  return value;
}

export function parseDockerBackupArgs(args) {
  const normalized = args.filter((value) => value !== "--");
  const action = normalized[0];
  if (action !== "export" && action !== "restore") fail("usage: docker-backup-migrate export|restore ...");
  const dockerPath = executablePath(normalized);
  const container = option(normalized, "--container");
  if (!namePattern.test(container)) fail("container name is invalid");
  if (action === "export") {
    const output = path.resolve(option(normalized, "--output"));
    if (normalized.includes("--volume") || normalized.includes("--image")) fail("export does not accept --volume or --image");
    return { action, dockerPath, container, output };
  }
  const image = option(normalized, "--image");
  const volume = option(normalized, "--volume");
  const snapshot = path.resolve(option(normalized, "--snapshot"));
  if (!imagePattern.test(image) || !namePattern.test(volume)) fail("image and volume names are invalid");
  return { action, dockerPath, container, image, volume, snapshot };
}

function docker(dockerPath, args) {
  const result = spawnSync(dockerPath, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error !== undefined) fail(`docker command could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`docker command failed: docker ${args.join(" ")}\n${result.stderr ?? ""}`);
  return result;
}

function dockerExists(dockerPath, args) {
  const result = spawnSync(dockerPath, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error !== undefined) fail(`docker command could not start: ${result.error.message}`);
  return result.status === 0;
}

function ensureNewDirectory(target, label) {
  if (fs.existsSync(target)) fail(`${label} must not already exist: ${target}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
}

export function exportDockerBackup({ dockerPath, container, output }) {
  ensureNewDirectory(output, "output directory");
  docker(dockerPath, ["exec", container, "node", "dist/backup-cli.js", "backup", "--data-dir", "/var/lib/carmediahub", "--output", "/tmp/cmh-backup"]);
  docker(dockerPath, ["cp", `${container}:/tmp/cmh-backup`, output]);
  return { action: "export", container, output };
}

export function restoreDockerBackup({ dockerPath, container, image, volume, snapshot }) {
  if (!fs.existsSync(snapshot) || !fs.statSync(snapshot).isDirectory()) fail("snapshot must be an existing directory");
  const helper = `${container}-restore`;
  if (dockerExists(dockerPath, ["volume", "inspect", volume])) fail(`restore volume already exists: ${volume}`);
  docker(dockerPath, ["volume", "create", volume]);
  docker(dockerPath, ["create", "--name", helper, "--entrypoint", "/bin/sh", "-v", `${volume}:/var/lib/carmediahub`, image, "-c", "while :; do sleep 3600; done"]);
  try {
    docker(dockerPath, ["start", helper]);
    docker(dockerPath, ["cp", snapshot, `${helper}:/tmp/cmh-snapshot`]);
    docker(dockerPath, ["exec", helper, "node", "dist/backup-cli.js", "restore", "--snapshot", "/tmp/cmh-snapshot", "--data-dir", "/tmp/cmh-restored-data"]);
    docker(dockerPath, ["exec", helper, "cp", "-a", "/tmp/cmh-restored-data/.", "/var/lib/carmediahub/"]);
  } finally {
    docker(dockerPath, ["rm", "-f", helper]);
  }
  return { action: "restore", container, image, volume, snapshot };
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const command = parseDockerBackupArgs(process.argv.slice(2));
    console.log(JSON.stringify(command.action === "export" ? exportDockerBackup(command) : restoreDockerBackup(command)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Docker backup migration failed");
    process.exitCode = 1;
  }
}
