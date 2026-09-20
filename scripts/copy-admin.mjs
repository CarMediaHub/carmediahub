import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "admin", "dist");
const target = path.join(root, "public", "admin");
if (!fs.existsSync(source)) throw new Error("Admin build does not exist; run pnpm build:admin first");
fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(source, target, { recursive: true });
