import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { listeningAddress, parseConfig } from "./config.js";

// Resolve defaults from the installed bundle, never from the service manager's cwd.
const installationRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = parseConfig(process.argv.slice(2), installationRoot);
const app = await createApp({ dataDir: config.dataDir, cookieSecure: config.cookieSecure });
await app.listen({ host: config.host, port: config.port });
console.log(`CarMediaHub Core listening on ${listeningAddress(config)}`);
