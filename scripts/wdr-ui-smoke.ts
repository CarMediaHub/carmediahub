import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { createApp } from "../src/app.js";
import { canonicalPluginPackageRelease } from "../src/plugin-package-release.js";

type Options = { executable: string; keep: boolean };

function parseArgs(argv: readonly string[]): Options {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  let executable = "";
  let keep = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--runtime-executable") executable = args[++index] ?? "";
    else if (value === "--keep") keep = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (executable === "") throw new Error("Usage: pnpm smoke:wdr-ui -- --runtime-executable <chrome> [--keep]");
  const resolved = path.resolve(executable);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error("Runtime executable is not a file");
  return { executable: resolved, keep };
}

function packageDigest(root: string): string {
  const files: string[] = [];
  const collect = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const location = path.join(current, entry.name);
      if (entry.isDirectory()) collect(location);
      else if (entry.isFile()) files.push(path.relative(root, location).split(path.sep).join("/"));
    }
  };
  collect(root);
  const hash = crypto.createHash("sha256");
  for (const relative of files.sort()) hash.update(`${relative}\0${crypto.createHash("sha256").update(fs.readFileSync(path.join(root, relative))).digest("hex")}\n`, "utf8");
  return hash.digest("hex");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const root = path.resolve(import.meta.dirname, "..");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-wdr-ui-"));
  const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-wdr-ui-media-"));
  fs.writeFileSync(path.join(mediaRoot, "road-trip.mp4"), "controlled smoke media");
  const pair = crypto.generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const keyId = crypto.createHash("sha256").update(publicKey).digest("hex").slice(0, 16);
  const source = path.join(dataDir, "staging", "plugins", "wdr-ui-build");
  const packagedWdr = path.resolve(root, "..", "carmediahub-plugins", "dist", "packages", "wdr-media");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.cpSync(packagedWdr, source, { recursive: true });
  const app = await createApp({ dataDir, pluginTrustKeys: [publicKey] });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await app.inject({ method: "POST", url: "/api/bootstrap", payload: { username: "smoke-admin", password: "correct horse battery staple", locale: "zh-CN" } });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "smoke-admin", password: "correct horse battery staple" } });
    const cookie = String(login.headers["set-cookie"]).split(";", 1)[0];
    const manifest = {
      id: "wdr-media", version: "0.1.0", sdk: "^0.1.0",
      name: { en: "WDR Media", "zh-CN": "WDR 媒体", ko: "WDR 미디어" },
      description: { en: "Media", "zh-CN": "媒体", ko: "미디어" },
      category: "official", runtime: "isolated-worker", capabilities: ["db", "storage", "media", "media-source", "history", "catalog", "display", "jobs", "events"],
      routes: [{ path: "/", methods: ["GET"] }, { path: "/library", methods: ["GET"] }, { path: "/stream", methods: ["GET", "HEAD"] }, { path: "/health", methods: ["GET"] }, { path: "/hls", methods: ["GET"] }],
      worker: { entry: "./worker.js", protocol: "0.1" }, ui: { entry: "./ui/index.html", vehicleSupported: true }
    } as const;
    const unsigned = { keyId, manifest, artifact: { id: "wdr-ui-build", digest: packageDigest(source) } };
    const release = { ...unsigned, signature: crypto.sign(null, canonicalPluginPackageRelease(unsigned), pair.privateKey).toString("base64") };
    const installed = await app.inject({ method: "POST", url: "/api/plugins/packages/install", headers: { cookie }, payload: release });
    if (installed.statusCode !== 201) throw new Error(`WDR install returned ${installed.statusCode}: ${installed.body}`);
    const installationId = (installed.json() as { installation: { id: string } }).installation.id;
    const rootResult = await app.inject({ method: "POST", url: "/api/media-roots", headers: { cookie }, payload: { installationId, name: "Smoke media", path: mediaRoot } });
    if (rootResult.statusCode !== 201) throw new Error(`Media root returned ${rootResult.statusCode}: ${rootResult.body}`);
    const workerHealth = await app.inject({ method: "GET", url: `/apps/wdr-media/${installationId}/health`, headers: { cookie } });
    if (workerHealth.statusCode !== 200) throw new Error(`WDR worker health returned ${workerHealth.statusCode}: ${workerHealth.body}`);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("Core listener address is unavailable");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const appUrl = `${baseUrl}/apps/wdr-media/${installationId}`;
    const [cookieName, cookieValue] = cookie.split("=", 2);
    browser = await chromium.launch({ executablePath: options.executable, headless: true, args: ["--mute-audio"], env: {} });
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await desktop.addCookies([{ name: cookieName!, value: cookieValue!, url: baseUrl }]);
    const desktopPage = await desktop.newPage();
    const failures: string[] = [];
    desktopPage.on("pageerror", (error) => failures.push(error.message));
    await desktopPage.goto(appUrl, { waitUntil: "domcontentloaded", timeout: 10_000 });
    await desktopPage.getByPlaceholder("搜索媒体").waitFor({ state: "visible", timeout: 10_000 });
    await desktopPage.getByRole("button", { name: "播放" }).waitFor({ state: "visible", timeout: 10_000 });
    if (await desktopPage.locator(".media-item").count() !== 1) throw new Error("Desktop WDR library did not render exactly one media item");
    await desktopPage.getByRole("button", { name: "播放" }).click();
    await desktopPage.getByRole("button", { name: "全屏" }).waitFor({ state: "visible", timeout: 10_000 });
    const fullscreenControl = await desktopPage.getByRole("button", { name: "全屏" }).isVisible();
    await desktopPage.getByRole("button", { name: "关闭" }).click();
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
    await mobile.addCookies([{ name: cookieName!, value: cookieValue!, url: baseUrl }]);
    const mobilePage = await mobile.newPage();
    await mobilePage.goto(appUrl, { waitUntil: "domcontentloaded", timeout: 10_000 });
    await mobilePage.getByRole("button", { name: "播放" }).waitFor({ state: "visible", timeout: 10_000 });
    const columns = await mobilePage.locator(".library").evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length);
    if (columns !== 2) throw new Error(`Mobile WDR library expected two columns, received ${columns}`);
    if (failures.length > 0) throw new Error(`WDR UI page errors: ${failures.join("; ")}`);
    console.log(JSON.stringify({ desktop: desktopPage.url(), mobile: mobilePage.url(), locale: "zh-CN", mediaItems: 1, fullscreenControl, mobileColumns: columns, silent: true }, null, 2));
    await desktop.close();
    await mobile.close();
  } finally {
    await browser?.close();
    await app.close();
    if (!options.keep) { fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(mediaRoot, { recursive: true, force: true }); }
  }
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
