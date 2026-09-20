import path from "node:path";

export interface CoreConfig {
  dataDir: string;
  host: string;
  port: number;
  publicUrl?: string;
  cookieSecure: boolean;
}

export function parseConfig(args: readonly string[], workingDirectory = process.cwd()): CoreConfig {
  let dataDir = path.join(workingDirectory, "data");
  let host = "127.0.0.1";
  let port = 8787;
  let publicUrl: string | undefined;
  let cookieSecure = false;

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
    } else if (value === "--public-url" && next !== undefined) {
      const url = new URL(next);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("public-url must use HTTP or HTTPS");
      publicUrl = url.toString().replace(/\/$/u, "");
      index += 1;
    } else if (value === "--cookie-secure") {
      cookieSecure = true;
    }
  }

  return { dataDir, host, port, ...(publicUrl === undefined ? {} : { publicUrl }), cookieSecure: cookieSecure || (publicUrl?.startsWith("https://") ?? false) };
}
