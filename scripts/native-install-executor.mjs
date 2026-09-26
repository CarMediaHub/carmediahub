import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { validateNativeInstallActions } from "./native-install-actions.mjs";

const commandPaths = {
  linux: {
    useradd: "/usr/sbin/useradd",
    install: "/usr/bin/install",
    chown: "/usr/bin/chown",
    systemctl: "/usr/bin/systemctl",
  },
  windows: {
    "icacls.exe": "C:\\Windows\\System32\\icacls.exe",
    "sc.exe": "C:\\Windows\\System32\\sc.exe",
  },
};

function fail(message) { throw new Error(`Native install executor failed: ${message}`); }

export class NativeInstallExecutionError extends Error {
  constructor(message, { platform, failedActionIndex, appliedActions, compensation, cause } = {}) {
    super(`Native install executor failed: ${message}`, { cause });
    this.name = "NativeInstallExecutionError";
    this.platform = platform;
    this.failedActionIndex = failedActionIndex;
    this.appliedActions = appliedActions;
    this.compensation = compensation;
  }
}

function validateCommandPaths(platform, overrides = {}) {
  const selected = { ...commandPaths[platform], ...overrides };
  for (const [command, executable] of Object.entries(selected)) {
    if (typeof executable !== "string" || executable.length === 0 || /[\u0000\r\n]/u.test(executable)) fail(`command path for ${command} is invalid`);
    const absolute = platform === "windows" ? path.win32.isAbsolute(executable) : path.posix.isAbsolute(executable);
    if (!absolute) fail(`command path for ${command} must be absolute`);
  }
  return selected;
}

export function executeNativeInstallActions(actions, platform, options = {}) {
  validateNativeInstallActions(actions, platform);
  const paths = validateCommandPaths(platform, options.commandPaths);
  const apply = options.apply === true;
  const execute = options.execute ?? ((executable, args, stdin) => {
    const result = spawnSync(executable, args, { input: stdin, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) fail(`${path.basename(executable)} exited with status ${result.status}: ${String(result.stderr ?? "").trim()}`);
    return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
  });
  const inspectEnsure = options.inspectEnsure;
  const executed = [];
  for (const [index, item] of actions.entries()) {
    const executable = paths[item.command];
    if (executable === undefined) fail(`no explicit executable path for ${item.command}`);
    if (!apply) {
      executed.push({ command: item.command, executable, args: [...item.args], applied: false, idempotency: item.idempotency });
      continue;
    }
    if (item.idempotency === "ensure") {
      if (typeof inspectEnsure !== "function") fail(`an explicit ensure inspection is required before applying ${item.command}`);
      const state = inspectEnsure(item, executable);
      if (state !== "missing" && state !== "matching" && state !== "mismatch") fail("ensure inspection returned an invalid state");
      if (state === "mismatch") fail(`existing ${item.command} target does not match the requested plan`);
      if (state === "matching") {
        executed.push({ command: item.command, executable, args: [...item.args], applied: false, skipped: true, idempotency: item.idempotency });
        continue;
      }
    }
    let staging;
    try {
      // Linux install(1) cannot reliably reopen /dev/stdin from Node's
      // spawnSync pipe on WSL. Keep the public action contract unchanged,
      // but stage the already-validated unit text in a private temp file.
      let executionArgs = item.args;
      if (item.stdin !== undefined) {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "carmediahub-native-"));
        staging = path.join(directory, "stdin");
        fs.writeFileSync(staging, item.stdin, { encoding: "utf8", mode: 0o600, flag: "wx" });
        executionArgs = item.args.map((value) => value === "/dev/stdin" ? staging : value);
      }
      const result = execute(executable, executionArgs, undefined);
      executed.push({ command: item.command, executable, args: [...item.args], applied: true, idempotency: item.idempotency, result });
    } catch (error) {
      const appliedActions = executed.filter((entry) => entry.applied);
      let compensation;
      if (options.compensateOnFailure === true) {
        if (typeof options.compensate !== "function") {
          throw new NativeInstallExecutionError(`action ${index} (${item.command}) failed and compensation was requested without a compensation handler`, {
            platform,
            failedActionIndex: index,
            appliedActions,
            compensation: { attempted: false, status: "handler-missing" },
            cause: error,
          });
        }
        const results = [];
        let compensationError;
        for (const applied of [...appliedActions].reverse()) {
          try {
            results.push({ action: applied, result: options.compensate(applied) });
          } catch (cause) {
            compensationError = cause;
            results.push({ action: applied, error: cause });
            break;
          }
        }
        compensation = {
          attempted: true,
          status: compensationError ? "failed" : "completed",
          results,
          error: compensationError,
        };
      }
      throw new NativeInstallExecutionError(`action ${index} (${item.command}) failed after ${executed.filter((entry) => entry.applied).length} action(s) were applied`, {
        platform,
        failedActionIndex: index,
        appliedActions,
        compensation,
        cause: error,
      });
    } finally {
      if (staging !== undefined) {
        fs.rmSync(path.dirname(staging), { recursive: true, force: true });
      }
    }
  }
  return { platform, applied: apply, actions: executed };
}

export { commandPaths };
