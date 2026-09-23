import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function validateDeployment(compose, dockerfile) {
  const fail = (message) => { throw new Error(`Deployment validation failed: ${message}`); };
  if (!/^services:\s*\r?\n\s+core:\s*$/mu.test(compose)) fail("Compose must define Core as the service entry");
  if (!/build:\s*\r?\n\s+context:\s+\.\.\s*\r?\n\s+dockerfile:\s+carmediahub\/Dockerfile/u.test(compose)) fail("Compose must build from the sibling workspace context and explicit Core Dockerfile");
  if (/^\s{2,}(postgres|postgresql|broker|plugin|worker)\s*:/mu.test(compose)) fail("Compose must not publish auxiliary services before their runtime contract is wired");
  if (!/127\.0\.0\.1:8787:8787/u.test(compose)) fail("Core port must bind to loopback by default");
  if (!/volumes:\s*\r?\n\s+- carmediahub-data:\/var\/lib\/carmediahub/u.test(compose)) fail("Compose must persist only the managed Core data directory");
  if (!/read_only:\s*true/u.test(compose) || !/no-new-privileges:true/u.test(compose)) fail("Compose hardening defaults are missing");
  if (!/healthcheck:\s*\r?\n\s+test:\s*\["CMD",\s*"node",/u.test(compose)) fail("Compose must define a Core liveness healthcheck");
  const portSection = compose.match(/\n\s+ports:\s*\r?\n((?:\s+-.*\r?\n)*)/u)?.[1] ?? "";
  const portLines = portSection.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (portLines.some((line) => !line.includes("127.0.0.1:8787:8787"))) fail("A non-Core host port is exposed");
  if (!/EXPOSE\s+8787/u.test(dockerfile) || !/ENTRYPOINT\s*\["node",\s*"dist\/cli\.js"/u.test(dockerfile)) fail("Docker image must expose only the Core entrypoint");
  if (!/COPY\s+carmediahub\/config\/components\.json\s+carmediahub\/config\/components\.schema\.json\s+carmediahub\/config\/core\.schema\.json\s+carmediahub\/config\/core\.example\.json/u.test(dockerfile) || !/COPY --from=build\s+\/workspace\/carmediahub\/config\/components\.json\s+\/workspace\/carmediahub\/config\/components\.schema\.json\s+\/workspace\/carmediahub\/config\/core\.schema\.json\s+\/workspace\/carmediahub\/config\/core\.example\.json/u.test(dockerfile)) fail("Docker image must copy only controlled configuration artifacts");
  if (/COPY(?:\s+--from=build)?\s+[^\n]*carmediahub\/config\s+\.\/?config\s*$/mu.test(dockerfile)) fail("Docker image must not copy the whole configuration directory");
  if (/^ENV\s+(?:PATH|PG[A-Z_]*)(?:=|\s)/mu.test(dockerfile)) fail("Docker image must not require implicit PATH or PG environment configuration");
  if (!/--data-dir",\s*"\/var\/lib\/carmediahub"/u.test(dockerfile)) fail("Docker image must use the explicit managed data directory");
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  validateDeployment(fs.readFileSync(path.join(root, "compose.yaml"), "utf8"), fs.readFileSync(path.join(root, "Dockerfile"), "utf8"));
  console.log("Deployment configuration passed static validation.");
}
