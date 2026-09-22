import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compose = fs.readFileSync(path.join(root, "compose.yaml"), "utf8");
const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
const fail = (message) => { throw new Error(`Deployment validation failed: ${message}`); };

if (!/^services:\s*\r?\n\s+core:\s*$/mu.test(compose)) fail("Compose must define Core as the service entry");
if (/^\s{2,}(postgres|postgresql|broker|plugin|worker)\s*:/mu.test(compose)) fail("Compose must not publish auxiliary services before their runtime contract is wired");
if (!/127\.0\.0\.1:8787:8787/u.test(compose)) fail("Core port must bind to loopback by default");
if (!/read_only:\s*true/u.test(compose) || !/no-new-privileges:true/u.test(compose)) fail("Compose hardening defaults are missing");
const portSection = compose.match(/\n\s+ports:\s*\r?\n((?:\s+-.*\r?\n)*)/u)?.[1] ?? "";
const portLines = portSection.split(/\r?\n/u).filter((line) => line.trim().length > 0);
if (portLines.some((line) => !line.includes("127.0.0.1:8787:8787"))) fail("A non-Core host port is exposed");
if (!/EXPOSE\s+8787/u.test(dockerfile) || !/ENTRYPOINT\s*\["node",\s*"dist\/cli\.js"/u.test(dockerfile)) fail("Docker image must expose only the Core entrypoint");
if (/^ENV\s+(?:PATH|PG[A-Z_]*)(?:=|\s)/mu.test(dockerfile)) fail("Docker image must not require implicit PATH or PG environment configuration");
if (!/--data-dir",\s*"\/var\/lib\/carmediahub"/u.test(dockerfile)) fail("Docker image must use the explicit managed data directory");
console.log("Deployment configuration passed static validation.");
