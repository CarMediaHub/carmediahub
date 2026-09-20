import path from "node:path";

export interface CoreConfig {
  dataDir: string;
  host: string;
  port: number;
}

export function parseConfig(args: readonly string[], workingDirectory = process.cwd()): CoreConfig {
  let dataDir = path.join(workingDirectory, "data");
  let host = "127.0.0.1";
  let port = 8787;

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    const next = args[index + 1];
    if (value === "--data-dir" && next !== undefined) {
      dataDir = path.resolve(next);
      index += 1;
    } else if (value === "--host" && next !== undefined) {
      host = next;
      index += 1;
    } else if (value === "--port" && next !== undefined && /^\d+$/.test(next)) {
      port = Number(next);
      index += 1;
    }
  }

  return { dataDir, host, port };
}
