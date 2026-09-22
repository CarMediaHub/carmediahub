import { createBackupSnapshot, restoreBackupSnapshot } from "./backup-service.js";

export type BackupCommand =
  | { action: "backup"; dataDir: string; output: string }
  | { action: "restore"; snapshot: string; dataDir: string };

function required(args: readonly string[], name: string, index: number): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--") || value.length === 0) throw new Error(`${name} requires a value`);
  return value;
}

export function parseBackupCommand(args: readonly string[]): BackupCommand {
  const action = args[0];
  if (action !== "backup" && action !== "restore") throw new Error("Usage: backup --data-dir <dir> --output <snapshot> | restore --snapshot <snapshot> --data-dir <new-dir>");
  let dataDir: string | undefined;
  let output: string | undefined;
  let snapshot: string | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--data-dir") { dataDir = required(args, value, index); index += 1; }
    else if (value === "--output") { output = required(args, value, index); index += 1; }
    else if (value === "--snapshot") { snapshot = required(args, value, index); index += 1; }
    else throw new Error(`Unknown option: ${value}`);
  }
  if (dataDir === undefined) throw new Error("--data-dir is required");
  if (action === "backup") {
    if (output === undefined || snapshot !== undefined) throw new Error("backup requires --output and does not accept --snapshot");
    return { action, dataDir, output };
  }
  if (snapshot === undefined || output !== undefined) throw new Error("restore requires --snapshot and does not accept --output");
  return { action, snapshot, dataDir };
}

export function runBackupCommand(command: BackupCommand): void {
  const manifest = command.action === "backup" ? createBackupSnapshot(command.dataDir, command.output) : restoreBackupSnapshot(command.snapshot, command.dataDir);
  process.stdout.write(`${JSON.stringify({ action: command.action, files: manifest.files.length, createdAt: manifest.createdAt })}\n`);
}

if (process.argv[1]?.endsWith("backup-cli.js") === true || process.argv[1]?.endsWith("backup-cli.ts") === true) {
  try { runBackupCommand(parseBackupCommand(process.argv.slice(2))); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "Backup command failed"}\n`); process.exitCode = 1; }
}
