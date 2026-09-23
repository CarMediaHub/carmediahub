import path from "node:path";

const identity = /^[a-z][a-z0-9._-]{0,127}$/u;

export interface BrowserLaunchSpec {
  userDataDir: string;
  args: readonly string[];
}

/** Builds the only supported Chromium launch contract; it does not start a browser. */
export function buildBrowserLaunchSpec(dataDir: string, scope: { organizationId: string; userId: string; installationId: string; sessionId: string }): BrowserLaunchSpec {
  for (const value of Object.values(scope)) if (!identity.test(value)) throw new Error("Browser scope identity is invalid");
  const browserRoot = path.resolve(dataDir, "browser", "sessions");
  const userDataDir = path.resolve(browserRoot, scope.organizationId, scope.userId, scope.installationId, scope.sessionId);
  if (!userDataDir.startsWith(`${browserRoot}${path.sep}`)) throw new Error("Browser User Data path escaped managed directory");
  return {
    userDataDir,
    args: Object.freeze([
      "--headless=new",
      "--mute-audio",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-sync",
      "--disable-background-networking",
      "--remote-debugging-pipe",
      `--user-data-dir=${userDataDir}`
    ])
  };
}
