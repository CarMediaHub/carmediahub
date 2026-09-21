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
    if (value === "--data-dir") {
      if (next === undefined || next.startsWith("--")) throw new Error("--data-dir requires a value");
      dataDir = path.resolve(next);
      index += 1;
    } else if (value === "--host") {
      if (next === undefined || next.startsWith("--") || next.length > 255 || /\s/u.test(next)) throw new Error("--host requires a valid value");
      host = next;
      index += 1;
    } else if (value === "--port") {
      if (next === undefined || !/^\d+$/u.test(next)) throw new Error("--port requires a numeric value");
      const parsed = Number(next);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error("--port must be between 1 and 65535");
      port = parsed;
      index += 1;
    } else if (value === "--public-url") {
      if (next === undefined || next.startsWith("--")) throw new Error("--public-url requires a value");
      const url = new URL(next);
      if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") throw new Error("public-url must be a credential-free HTTP or HTTPS origin");
      publicUrl = url.toString().replace(/\/$/u, "");
      index += 1;
    } else if (value === "--cookie-secure") {
      cookieSecure = true;
    } else {
      throw new Error(`Unknown option: ${value}`);
    }
  }

  return { dataDir, host, port, ...(publicUrl === undefined ? {} : { publicUrl }), cookieSecure: cookieSecure || (publicUrl?.startsWith("https://") ?? false) };
}
