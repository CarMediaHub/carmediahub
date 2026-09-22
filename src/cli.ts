import { createApp } from "./app.js";
import { listeningAddress, parseConfig } from "./config.js";

const config = parseConfig(process.argv.slice(2));
const app = await createApp({ dataDir: config.dataDir, cookieSecure: config.cookieSecure });
await app.listen({ host: config.host, port: config.port });
console.log(`CarMediaHub Core listening on ${listeningAddress(config)}`);
