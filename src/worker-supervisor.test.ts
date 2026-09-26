import assert from "node:assert/strict";
import test from "node:test";
import { WorkerSupervisor, type TrustedWorkerFactory } from "./worker-supervisor.js";
import type { RuntimeCredentialScope } from "./runtime-broker.js";

const scope: RuntimeCredentialScope = {
  deploymentId: "dep", organizationId: "org", userId: "user", deviceId: "device", sessionId: "session", installationId: "plugin_one", locale: "en", timeZone: "UTC", theme: "system", density: "comfortable", entry: "navigation", display: { deviceClass: "unknown", input: [], fullscreenAvailable: false, viewport: { width: 0, height: 0 } }, policyVersion: 1
};

test("Supervisor starts only registered factories and reclaims idle workers", async () => {
  const pending = new Map<number, () => void>();
  let nextTimer = 0;
  let stopped = 0;
  let receivedCredential = "";
  const supervisor = new WorkerSupervisor({
    endpoint: "local-endpoint",
    issueCredential: () => "short-lived-credential",
    installation: (id) => id === "plugin_one" ? { packageId: "trusted-package", status: "installed" } : undefined,
    idleTimeoutMs: 1,
    stableRunMs: 0,
    schedule: (callback) => { const token = ++nextTimer; pending.set(token, callback); return token; },
    cancel: (token) => pending.delete(token as number)
  });
  const factory: TrustedWorkerFactory = {
    packageId: "trusted-package",
    async start(input) { receivedCredential = input.runtimeCredential; return { stop: () => { stopped += 1; } }; }
  };
  supervisor.register(factory);
  assert.equal((await supervisor.start("plugin_one", scope)).state, "running");
  assert.equal(receivedCredential, "short-lived-credential");
  assert.equal((await supervisor.start("unknown", { ...scope, installationId: "unknown" })).state, "disabled");
  const timer = [...pending.keys()][0];
  assert.ok(timer !== undefined);
  pending.get(timer!)!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(supervisor.status("plugin_one").state, "stopped");
  assert.equal(stopped, 1);
});

test("Supervisor retries crashes with bounded backoff and disables stopped installations", async () => {
  const pending: Array<{ callback: () => void; delay: number }> = [];
  let crash: ((error: Error) => void) | undefined;
  const supervisor = new WorkerSupervisor({
    endpoint: "local-endpoint",
    issueCredential: () => "credential",
    installation: () => ({ packageId: "trusted-package", status: "installed" }),
    maxRestartAttempts: 1,
    stableRunMs: 0,
    schedule: (callback, delay) => { pending.push({ callback, delay }); return pending.length; },
    cancel: () => undefined
  });
  let starts = 0;
  supervisor.register({ packageId: "trusted-package", async start() { starts += 1; return { stop() {}, onCrash(listener) { crash = listener; } }; } });
  await supervisor.start("plugin_one", scope);
  crash!(new Error("unexpected exit"));
  assert.equal(supervisor.status("plugin_one").state, "backoff");
  const restart = pending.find((item) => item.delay === 1_000)?.callback;
  assert.ok(restart);
  restart!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 2);
  crash!(new Error("second exit"));
  assert.equal(supervisor.status("plugin_one").state, "failed");
});

test("Supervisor cancels a pending crash restart when the worker is stopped", async () => {
  const pending: Array<{ callback: () => void; delay: number }> = [];
  let crash: ((error: Error) => void) | undefined;
  let starts = 0;
  const supervisor = new WorkerSupervisor({
    endpoint: "local-endpoint",
    issueCredential: () => "credential",
    installation: () => ({ packageId: "trusted-package", status: "installed" }),
    schedule: (callback, delay) => { pending.push({ callback, delay }); return pending.length; },
    cancel: (handle) => { pending[Number(handle) - 1]!.callback = () => undefined; }
  });
  supervisor.register({ packageId: "trusted-package", async start() { starts += 1; return { stop() {}, onCrash(listener) { crash = listener; } }; } });
  await supervisor.start("plugin_one", scope);
  crash!(new Error("unexpected exit"));
  assert.equal(supervisor.status("plugin_one").state, "backoff");
  await supervisor.stop("plugin_one");
  pending[0]!.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 1);
  assert.equal(supervisor.status("plugin_one").state, "stopped");
});

test("Supervisor stops a worker that finishes after its start was stopped", async () => {
  let resolveStart: ((handle: { stop(): void }) => void) | undefined;
  let stopped = 0;
  const supervisor = new WorkerSupervisor({
    endpoint: "local-endpoint",
    issueCredential: () => "credential",
    installation: () => ({ packageId: "trusted-package", status: "installed" })
  });
  supervisor.register({
    packageId: "trusted-package",
    async start() { return await new Promise<{ stop(): void }>((resolve) => { resolveStart = resolve; }); }
  });
  const starting = supervisor.start("plugin_one", scope);
  await new Promise((resolve) => setImmediate(resolve));
  await supervisor.stop("plugin_one");
  resolveStart!({ stop() { stopped += 1; } });
  await starting;
  assert.equal(stopped, 1);
  assert.equal(supervisor.status("plugin_one").state, "stopped");
});

test("Supervisor selects the factory matching the installed package version", async () => {
  const selected: string[] = [];
  const supervisor = new WorkerSupervisor({
    endpoint: "local-endpoint",
    issueCredential: () => "credential",
    installation: () => ({ packageId: "versioned-package", packageVersion: "2.0.0", status: "installed" })
  });
  supervisor.register({ packageId: "versioned-package", packageVersion: "1.0.0", async start() { selected.push("1"); return { stop() {} }; } });
  supervisor.register({ packageId: "versioned-package", packageVersion: "2.0.0", async start() { selected.push("2"); return { stop() {} }; } });
  await supervisor.start("plugin_one", scope);
  assert.deepEqual(selected, ["2"]);
});

test("Supervisor ignores a stale crash callback after stop", async () => {
  let crash: ((error: Error) => void) | undefined;
  let installationLookups = 0;
  const supervisor = new WorkerSupervisor({
    endpoint: "local-endpoint",
    issueCredential: () => "credential",
    installation: () => { installationLookups += 1; return { packageId: "trusted-package", status: "installed" }; },
    idleTimeoutMs: 60_000,
    schedule: (callback, delay) => { if (delay < 60_000) throw new Error("stale crash scheduled a restart"); return { callback, delay }; },
    cancel: () => undefined,
  });
  supervisor.register({ packageId: "trusted-package", async start() { return { stop() {}, onCrash(listener) { crash = listener; } }; } });
  await supervisor.start("plugin_one", scope);
  await supervisor.stop("plugin_one");
  const lookupsAfterStop = installationLookups;
  crash!(new Error("late exit"));
  assert.equal(installationLookups, lookupsAfterStop);
  assert.equal(supervisor.status("plugin_one").state, "stopped");
});

test("Supervisor runs one isolated Worker per user scope", async () => {
  const started: string[] = [];
  const supervisor = new WorkerSupervisor({
    endpoint: "local-endpoint",
    issueCredential: (current) => current.userId,
    installation: () => ({ packageId: "trusted-package", status: "installed" })
  });
  supervisor.register({ packageId: "trusted-package", async start(input) { started.push(input.scope.userId); return { stop() {} }; } });
  await supervisor.start("plugin_one", scope);
  await supervisor.start("plugin_one", { ...scope, userId: "user-two", sessionId: "session-two" });
  assert.deepEqual(started.sort(), ["user", "user-two"]);
  await supervisor.stop("plugin_one");
  assert.equal(supervisor.status("plugin_one").state, "stopped");
});

test("Supervisor resets consecutive crash attempts after a stable run", async () => {
  const pending: Array<{ callback: () => void; delay: number }> = [];
  let crash: ((error: Error) => void) | undefined;
  let starts = 0;
  const supervisor = new WorkerSupervisor({
    endpoint: "local-endpoint",
    issueCredential: () => "credential",
    installation: () => ({ packageId: "trusted-package", status: "installed" }),
    maxRestartAttempts: 1,
    stableRunMs: 5_000,
    schedule: (callback, delay) => { pending.push({ callback, delay }); return pending.length; },
    cancel: () => undefined,
  });
  supervisor.register({ packageId: "trusted-package", async start() { starts += 1; return { stop() {}, onCrash(listener) { crash = listener; } }; } });
  await supervisor.start("plugin_one", scope);
  crash!(new Error("first exit"));
  const restart = pending.find((item) => item.delay === 1_000)?.callback;
  assert.ok(restart);
  restart!();
  await new Promise((resolve) => setImmediate(resolve));
  const stable = pending.find((item) => item.delay === 5_000)?.callback;
  assert.ok(stable);
  stable!();
  crash!(new Error("later exit"));
  assert.equal(supervisor.status("plugin_one").state, "backoff");
  assert.equal(starts, 2);
});
