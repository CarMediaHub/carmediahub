import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function packageList() { const args = ["list", "--json", "--prod", "--depth", "Infinity"]; return process.platform === "win32" ? execFileSync("cmd.exe", ["/d", "/s", "/c", `pnpm ${args.join(" ")}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) : execFileSync("pnpm", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
function packageJson(location) {
  try { return JSON.parse(fs.readFileSync(path.join(location, "package.json"), "utf8")); } catch { return {}; }
}
function packageVersion(node) {
  if (typeof node.version === "string" && !node.version.startsWith("file:")) return node.version;
  const version = packageJson(node.path).version;
  return typeof version === "string" ? version : "0.0.0-local";
}
function packagePurl(name, version) {
  return `pkg:npm/${name.startsWith("@") ? name.replace("/", "%2F") : name}@${encodeURIComponent(version)}`;
}
function collect(node, components) {
  const name = node?.name ?? node?.from;
  if (name && name !== packageJson(root).name) {
    const version = packageVersion(node);
    const purl = packagePurl(name, version);
    const metadata = packageJson(node.path);
    components.set(purl, { type: "library", name, version, "bom-ref": purl, purl, ...(typeof metadata.license === "string" ? { licenses: [{ license: { id: metadata.license } }] } : {}) });
  }
  for (const dependency of Object.values(node?.dependencies ?? {})) collect(dependency, components);
}
function parseOutput(output) {
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start < 0 || end < start) throw new Error("pnpm list did not return JSON");
  return JSON.parse(output.slice(start, end + 1));
}
export function generateSbom(output = path.join(root, "sbom", "cyclonedx.json")) {
  const rootPackage = packageJson(root);
  const listed = parseOutput(packageList());
  const components = new Map();
  for (const node of listed) collect(node, components);
  const bom = { "$schema": "http://cyclonedx.org/schema/bom-1.5.schema.json", bomFormat: "CycloneDX", specVersion: "1.5", version: 1, metadata: { component: { type: "application", name: rootPackage.name, version: rootPackage.version } }, components: [...components.values()].sort((left, right) => left.purl.localeCompare(right.purl)) };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(bom, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
  return bom;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv.slice(2).find((value) => value !== "--") ?? path.join(root, "sbom", "cyclonedx.json");
  console.log(JSON.stringify({ output, components: generateSbom(path.resolve(output)).components.length }));
}
