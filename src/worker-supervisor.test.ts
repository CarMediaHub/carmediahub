import assert from "node:assert/strict";
import test from "node:test";
import { WorkerSupervisor, type TrustedWorkerFactory } from "./worker-supervisor.js";
import type { RuntimeCredentialScope } from "./runtime-broker.js";

const scope: RuntimeCredentialScope = {
  deploymentId: "dep", organizationId: "org", userId: "user", deviceId: "device", sessionId: "session", installationId: "plugin_one", locale: "en", policyVersion: 1
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
