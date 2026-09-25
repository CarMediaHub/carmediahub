import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

type SmokeLocale = "en" | "zh-CN" | "ko";
type Options = { executable: string; keep: boolean; locale: SmokeLocale };

function parseArgs(argv: readonly string[]): Options {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  let executable = "";
  let keep = false;
  let locale: SmokeLocale = "en";
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--runtime-executable") executable = args[++index] ?? "";
    else if (value === "--keep") keep = true;
    else if (value === "--locale") {
      const candidate = args[++index] ?? "";
      if (candidate !== "en" && candidate !== "zh-CN" && candidate !== "ko") throw new Error("Locale must be en, zh-CN or ko");
      locale = candidate;
    }
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (executable === "") throw new Error("Usage: pnpm smoke:admin -- --runtime-executable <chrome> [--locale en|zh-CN|ko] [--keep]");
  return { executable: path.resolve(executable), keep, locale };
}

function localeStrings(locale: SmokeLocale): { username: string; password: string; submit: string; overview: string; plugins: string; signOut: string } {
  if (locale === "zh-CN") return { username: "用户名", password: "密码", submit: "登录", overview: "总览", plugins: "插件", signOut: "退出登录" };
  if (locale === "ko") return { username: "사용자 이름", password: "비밀번호", submit: "로그인", overview: "개요", plugins: "플러그인", signOut: "로그아웃" };
  return { username: "Username", password: "Password", submit: "Sign in", overview: "Overview", plugins: "Plugins", signOut: "Sign out" };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const root = path.resolve(import.meta.dirname, "..");
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cmh-admin-smoke-"));
  const port = 19000 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(root, "dist", "cli.js"), "--data-dir", dataDir, "--port", String(port)], { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let output = "";
  let exited = false;
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  child.once("exit", () => { exited = true; });
  try {
    let live = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (exited) throw new Error(`Core exited before liveness: ${output}`);
      try { if ((await fetch(`${baseUrl}/health/live`)).ok) { live = true; break; } } catch { /* wait for startup */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!live) throw new Error(`Core liveness timeout: ${output}`);
    const labels = localeStrings(options.locale);
    const bootstrap = await fetch(`${baseUrl}/api/bootstrap`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "smoke-admin", password: "correct horse battery staple", locale: options.locale }) });
    if (bootstrap.status !== 201) throw new Error(`bootstrap returned ${bootstrap.status}`);
    browser = await chromium.launch({ executablePath: options.executable, headless: true, args: ["--mute-audio"], env: {} });
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
    page.on("response", (response) => {
      if (response.status() >= 400 && !(response.url().endsWith("/api/me") && response.status() === 401) && response.status() !== 404) failures.push(`response ${response.status()}: ${response.url()}`);
    });
    await page.goto(`${baseUrl}/admin/login`, { waitUntil: "networkidle" });
    // Login is intentionally locale-neutral before /api/me is available; the
    // user's configured locale is applied after authentication.
    await page.getByPlaceholder("Username").fill("smoke-admin");
    await page.getByPlaceholder("Password").fill("correct horse battery staple");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(`${baseUrl}/admin/overview`);
    await page.locator(".ant-pro-layout").waitFor({ state: "visible", timeout: 10_000 });
    await page.getByText(labels.overview, { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    const navigation = await page.locator(".ant-menu-item").allTextContents();
    if (!navigation.includes(labels.overview) || !navigation.includes(labels.plugins)) throw new Error(`admin navigation is incomplete: ${JSON.stringify(navigation)}`);
    if (await page.getByRole("button", { name: labels.signOut }).count() !== 1) throw new Error("admin logout control is unavailable");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator(".ant-pro-layout").waitFor({ state: "visible", timeout: 10_000 });
    const mobileLayout = await page.evaluate(() => ({ viewportWidth: window.innerWidth, documentWidth: document.documentElement.scrollWidth, navigationVisible: document.querySelectorAll(".ant-menu-item").length > 0 }));
    if (mobileLayout.documentWidth > mobileLayout.viewportWidth + 1 || !mobileLayout.navigationVisible || await page.getByRole("button", { name: labels.signOut }).count() !== 1) throw new Error(`mobile admin layout is unusable: ${JSON.stringify(mobileLayout)}`);
    if (failures.length > 0) throw new Error(`admin browser failures: ${failures.join("; ")}`);
    console.log(JSON.stringify({ url: page.url(), locale: options.locale, navigationItems: navigation.length, mobileLayout, silent: true }, null, 2));
  } finally {
    await browser?.close();
    if (!exited) { child.kill(); await new Promise<void>((resolve) => child.once("exit", () => resolve())); }
    if (!options.keep) await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
