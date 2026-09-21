import path from "node:path";
import { pathToFileURL } from "node:url";

const values = new Map();
for (let index = 2; index < process.argv.length; index += 2) values.set(process.argv[index], process.argv[index + 1]);
const entry = values.get("--entry");
const endpoint = values.get("--endpoint");
const installationId = values.get("--installation-id");
const runtimeCredential = values.get("--runtime-credential");

if (![entry, endpoint, installationId, runtimeCredential].every((value) => typeof value === "string" && value.length > 0)) process.exit(64);
if (!path.isAbsolute(entry)) process.exit(64);

try {
  const module = await import(pathToFileURL(entry).href);
  if (typeof module.startWorker !== "function") process.exit(65);
  await module.startWorker({ endpoint, installationId, runtimeCredential });
} catch {
  process.exit(70);
}
