import fs from "node:fs";
import path from "node:path";

export interface CoreConfig {
  dataDir: string;
  host: string;
  port: number;
  publicUrl?: string;
  cookieSecure: boolean;
}

type ConfigFileValues = Partial<Pick<CoreConfig, "dataDir" | "host" | "port" | "publicUrl" | "cookieSecure">>;

const CONFIG_FILE_KEYS = new Set(["dataDir", "host", "port", "publicUrl", "cookieSecure"]);

function validateHost(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 255 || /\s/u.test(value)) throw new Error("--host requires a valid value");
  return value;
}

function validatePort(value: unknown): number {
  if ((typeof value !== "number" && typeof value !== "string") || !/^\d+$/u.test(String(value))) throw new Error("--port requires a numeric value");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error("--port must be between 1 and 65535");
  return parsed;
}

function validatePublicUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("--public-url requires a value");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("public-url must be a valid HTTP or HTTPS origin"); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.pathname !== "/") throw new Error("public-url must be a credential-free HTTP or HTTPS origin");
  return url.toString().replace(/\/$/u, "");
}

function readConfigFile(filePath: string, required: boolean): ConfigFileValues {
  if (!fs.existsSync(filePath)) {
    if (required) throw new Error(`Configuration file does not exist: ${filePath}`);
    return {};
  }
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown; } catch { throw new Error("Configuration file must contain valid JSON"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Configuration file must contain a JSON object");
  const values = parsed as Record<string, unknown>;
  for (const key of Object.keys(values)) if (!CONFIG_FILE_KEYS.has(key)) throw new Error(`Unknown configuration field: ${key}`);
  const result: ConfigFileValues = {};
  if ("dataDir" in values) {
    if (typeof values.dataDir !== "string" || values.dataDir.length === 0) throw new Error("dataDir must be a non-empty string");
    result.dataDir = values.dataDir;
  }
  if ("host" in values) result.host = validateHost(values.host);
  if ("port" in values) result.port = validatePort(values.port);
  if ("publicUrl" in values) result.publicUrl = validatePublicUrl(values.publicUrl);
  if ("cookieSecure" in values) {
    if (typeof values.cookieSecure !== "boolean") throw new Error("cookieSecure must be a boolean");
    result.cookieSecure = values.cookieSecure;
  }
  return result;
}

export function listeningAddress(config: Pick<CoreConfig, "host" | "port" | "publicUrl">): string {
  return config.publicUrl ?? `http://${config.host}:${config.port}`;
}

export function parseConfig(args: readonly string[], workingDirectory = process.cwd()): CoreConfig {
  const normalizedArgs = args.filter((value) => value !== "--");
  let configPath = path.join(workingDirectory, "config", "core.json");
  let explicitConfig = false;
  let configCount = 0;
  for (let index = 0; index < normalizedArgs.length; index += 1) {
    if (normalizedArgs[index] !== "--config") continue;
    configCount += 1;
    if (configCount > 1) throw new Error("--config may only be specified once");
    const next = normalizedArgs[index + 1];
    if (next === undefined || next.startsWith("--")) throw new Error("--config requires a value");
    configPath = path.resolve(workingDirectory, next);
    explicitConfig = true;
    index += 1;
  }
  const file = readConfigFile(configPath, explicitConfig);
  let dataDir = path.resolve(workingDirectory, file.dataDir ?? "data");
  let host = file.host ?? "127.0.0.1";
  let port = file.port ?? 8787;
  let publicUrl: string | undefined = file.publicUrl;
  let cookieSecure = file.cookieSecure ?? false;
  let cookieSecureExplicit = file.cookieSecure !== undefined;

  for (let index = 0; index < normalizedArgs.length; index += 1) {
    const value = normalizedArgs[index];
    const next = normalizedArgs[index + 1];
    if (value === "--config") {
      index += 1;
    } else if (value === "--data-dir") {
      if (next === undefined || next.startsWith("--")) throw new Error("--data-dir requires a value");
      dataDir = path.resolve(workingDirectory, next);
      index += 1;
    } else if (value === "--host") {
      if (next === undefined || next.startsWith("--")) throw new Error("--host requires a valid value");
      host = validateHost(next);
      index += 1;
    } else if (value === "--port") {
      port = validatePort(next);
      index += 1;
    } else if (value === "--public-url") {
      if (next === undefined || next.startsWith("--")) throw new Error("--public-url requires a value");
      publicUrl = validatePublicUrl(next);
      index += 1;
    } else if (value === "--cookie-secure") {
      cookieSecure = true;
      cookieSecureExplicit = true;
    } else if (value === "--no-cookie-secure") {
      cookieSecure = false;
      cookieSecureExplicit = true;
    } else {
      throw new Error(`Unknown option: ${value}`);
    }
  }

  return { dataDir, host, port, ...(publicUrl === undefined ? {} : { publicUrl }), cookieSecure: cookieSecureExplicit ? cookieSecure : (publicUrl?.startsWith("https://") ?? false) };
}
