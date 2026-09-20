import { createApp } from "./app.js";
import { parseConfig } from "./config.js";

const config = parseConfig(process.argv.slice(2));
const app = await createApp({ dataDir: config.dataDir });
await app.listen({ host: config.host, port: config.port });
console.log(`CarMediaHub Core listening on http://${config.host}:${config.port}`);
