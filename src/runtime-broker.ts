import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { CmhError, encodeFrame, FrameDecoder, validateWorkerRequest, type DisplayContext, type RpcRequest, type RpcResponse, type ScopeContext } from "@carmediahub/sdk";

export interface RuntimeCredentialScope extends ScopeContext {
  locale: "en" | "zh-CN" | "ko";
  timeZone: string;
  theme: "light" | "dark" | "system";
  density: "comfortable" | "compact";
  entry: "navigation" | "key";
  display: DisplayContext;
  policyVersion: number;
}

export interface RuntimeBrokerOptions {
  dataDir: string;
  endpoint?: string;
  credentialTtlMs?: number;
  installationEnabled(installationId: string): boolean;
  onWorkerRequest?(request: RpcRequest, scope: RuntimeCredentialScope): Promise<unknown> | unknown;
}

type ContextUpdate = Partial<Pick<RuntimeCredentialScope, "locale" | "timeZone" | "theme" | "density">>;

interface CredentialRecord {
  expiresAt: number;
  scope: RuntimeCredentialScope;
}

interface ConnectionState {
  installationId?: string;
  nonce?: string;
  scope?: RuntimeCredentialScope;
  requestIds: Set<string>;
  pending: Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>;
  streams: Map<string, { stream: ResponseStream; expectedSequence: number; timer: NodeJS.Timeout }>;
}

export interface GatewayInvocation {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | string[]>;
  headers?: Record<string, string>;
  body?: unknown;
}

function trustedGatewayInvocation(invocation: GatewayInvocation, scope: RuntimeCredentialScope, stream = false): GatewayInvocation & { stream?: boolean; context: { locale: RuntimeCredentialScope["locale"]; timeZone: string; theme: RuntimeCredentialScope["theme"]; density: RuntimeCredentialScope["density"]; entry: RuntimeCredentialScope["entry"]; display: DisplayContext; policyVersion: number } } {
  return { ...invocation, ...(stream ? { stream: true } : {}), context: { locale: scope.locale, timeZone: scope.timeZone, theme: scope.theme, density: scope.density, entry: scope.entry, display: scope.display, policyVersion: scope.policyVersion } };
}

function workerContext(scope: RuntimeCredentialScope) {
  return {
    scope: { deploymentId: scope.deploymentId, organizationId: scope.organizationId, userId: scope.userId, deviceId: scope.deviceId, sessionId: scope.sessionId, installationId: scope.installationId },
    locale: scope.locale, timeZone: scope.timeZone, theme: scope.theme, density: scope.density, entry: scope.entry, display: scope.display, policyVersion: scope.policyVersion
  };
}

export interface GatewayStreamStart { status: number; headers?: Record<string, string>; }
export interface GatewayStream extends AsyncIterable<Buffer> { readonly start: Promise<GatewayStreamStart>; cancel(reason?: string): void; }

class ResponseStream implements GatewayStream {
  readonly start: Promise<GatewayStreamStart>;
  private readonly queued: Buffer[] = [];
  private readonly waiters: Array<(result: IteratorResult<Buffer>) => void> = [];
  private startResolve!: (value: GatewayStreamStart) => void;
  private startReject!: (error: Error) => void;
  private ended = false;
  private failure: Error | undefined;
  constructor(private readonly onCancel: (reason: string) => void, private readonly maxQueue = 32) {
    this.start = new Promise<GatewayStreamStart>((resolve, reject) => { this.startResolve = resolve; this.startReject = reject; });
  }
  begin(value: GatewayStreamStart): void { this.startResolve(value); }
  push(chunk: Buffer): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter({ done: false, value: chunk });
    else if (this.queued.length < this.maxQueue) this.queued.push(chunk);
    else this.fail(new Error("Gateway stream backpressure limit exceeded"));
  }
  end(): void { if (this.ended) return; this.ended = true; while (this.waiters.length > 0) this.waiters.shift()!({ done: true, value: undefined }); }
  fail(error: Error): void { if (this.ended) return; this.failure = error; this.ended = true; this.startReject(error); while (this.waiters.length > 0) this.waiters.shift()!({ done: true, value: undefined }); }
  cancel(reason = "Gateway stream cancelled"): void { this.onCancel(reason); this.fail(new Error(reason)); }
  [Symbol.asyncIterator](): AsyncIterator<Buffer> {
    return { next: async () => { const chunk = this.queued.shift(); if (chunk !== undefined) return { done: false, value: chunk }; if (this.failure !== undefined) throw this.failure; if (this.ended) return { done: true, value: undefined }; return new Promise<IteratorResult<Buffer>>((resolve) => this.waiters.push(resolve)); }, return: async () => { this.cancel(); return { done: true, value: undefined }; } };
  }
}

function defaultEndpoint(dataDir: string): string {
  if (process.platform === "win32") return `\\\\.\\pipe\\carmediahub-${crypto.createHash("sha256").update(path.resolve(dataDir)).digest("hex").slice(0, 24)}`;
  return path.join(dataDir, "runtime", "broker.sock");
}

function errorShape(error: unknown) {
  if (error instanceof CmhError) return error.toJSON();
  return { code: "CMH.PROTOCOL.HANDSHAKE_DENIED", messageKey: "errors.protocol.handshakeDenied", retryable: false, diagnosticId: "diag_broker_denied" };
}

/**
 * Local-only Broker for native Worker processes. It never opens a TCP port;
 * all caller-provided identity is discarded in favor of the issued credential.
 */
export class RuntimeBroker {
  readonly endpoint: string;
  private readonly credentials = new Map<string, CredentialRecord>();
  private readonly sockets = new Set<net.Socket>();
  private server: net.Server | undefined;
  private readonly connectionWaiters = new Set<() => void>();

  constructor(private readonly options: RuntimeBrokerOptions) {
    this.endpoint = options.endpoint ?? defaultEndpoint(options.dataDir);
  }

  issueCredential(scope: RuntimeCredentialScope): string {
    if (!this.options.installationEnabled(scope.installationId)) throw new Error("Plugin installation is not enabled");
    const credential = crypto.randomBytes(32).toString("base64url");
    this.credentials.set(credential, { scope, expiresAt: Date.now() + (this.options.credentialTtlMs ?? 60_000) });
    return credential;
  }

  /** Broadcasts persisted user preference changes to matching authenticated Workers. */
  broadcastContext(userId: string, update: ContextUpdate): void {
    for (const connection of this.connections()) {
      const scope = connection.state.scope;
      if (scope === undefined || scope.userId !== userId || connection.socket.destroyed) continue;
      const updated = { ...scope, ...update, policyVersion: scope.policyVersion + 1 };
      connection.state.scope = updated;
      const requestId = `context_${crypto.randomUUID()}`;
      connection.socket.write(encodeFrame({ jsonrpc: "2.0", method: "context.changed", params: { context: workerContext(updated) }, meta: { schemaVersion: "0.1", requestId, traceId: requestId, deadlineUnixMs: 0, installationId: updated.installationId } }));
    }
  }

  invoke(installationId: string, scope: RuntimeCredentialScope, invocation: GatewayInvocation, timeoutMs = 30_000, signal?: AbortSignal): Promise<unknown> {
    const connection = [...this.connections()].find((candidate) => candidate.state.scope?.installationId === installationId && candidate.state.scope.userId === scope.userId);
    if (connection === undefined) return Promise.reject(new Error("Plugin worker is not connected"));
    const id = `gateway_${crypto.randomUUID()}`;
    const request: RpcRequest<GatewayInvocation> = {
      jsonrpc: "2.0", id, method: "gateway.request", params: trustedGatewayInvocation(invocation, scope),
      meta: { schemaVersion: "0.1", requestId: id, traceId: id, deadlineUnixMs: Date.now() + timeoutMs, installationId }
    };
    return new Promise((resolve, reject) => {
      const cancel = (reason: string) => {
        if (!connection.state.pending.delete(id)) return;
        clearTimeout(timer);
        connection.socket.write(encodeFrame({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id, reason }, meta: { schemaVersion: "0.1", requestId: id, traceId: id, deadlineUnixMs: 0, installationId } }));
        reject(new Error(reason));
      };
      const timer = setTimeout(() => cancel("Plugin gateway request timed out"), timeoutMs);
      connection.state.pending.set(id, { resolve, reject, timer });
      if (signal !== undefined) {
        if (signal.aborted) cancel("Plugin gateway request cancelled");
        else signal.addEventListener("abort", () => cancel("Plugin gateway request cancelled"), { once: true });
      }
      connection.socket.write(encodeFrame(request));
    });
  }

  /** Waits only for the authenticated local Worker matching this request scope. */
  waitForWorker(installationId: string, userId: string, timeoutMs = 5_000): Promise<void> {
    if (this.hasWorker(installationId, userId)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.connectionWaiters.delete(wake); reject(new Error("Plugin worker did not complete its broker handshake")); }, timeoutMs);
      const wake = () => {
        if (!this.hasWorker(installationId, userId)) return;
        clearTimeout(timeout); this.connectionWaiters.delete(wake); resolve();
      };
      this.connectionWaiters.add(wake);
      wake();
    });
  }

  invokeStream(installationId: string, scope: RuntimeCredentialScope, invocation: GatewayInvocation, timeoutMs = 30_000): GatewayStream {
    const connection = [...this.connections()].find((candidate) => candidate.state.scope?.installationId === installationId && candidate.state.scope.userId === scope.userId);
    let streamId: string | undefined;
    const stream = new ResponseStream((reason) => {
      if (connection === undefined || streamId === undefined) return;
      const entry = connection.state.streams.get(streamId);
      if (entry === undefined) return;
      clearTimeout(entry.timer); connection.state.streams.delete(streamId);
      connection.socket.write(encodeFrame({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: streamId, reason }, meta: { schemaVersion: "0.1", requestId: streamId, traceId: streamId, deadlineUnixMs: 0, installationId } }));
    });
    if (connection === undefined) { stream.fail(new Error("Plugin worker is not connected")); return stream; }
    streamId = `stream_${crypto.randomUUID()}`;
    const timer = setTimeout(() => {
      const entry = connection.state.streams.get(streamId!);
      if (entry !== undefined) { connection.state.streams.delete(streamId!); entry.stream.fail(new Error("Plugin gateway stream timed out")); connection.socket.write(encodeFrame({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: streamId, reason: "Plugin gateway stream timed out" }, meta: { schemaVersion: "0.1", requestId: streamId, traceId: streamId, deadlineUnixMs: 0, installationId } })); }
    }, timeoutMs);
    connection.state.streams.set(streamId, { stream, expectedSequence: 0, timer });
    connection.socket.write(encodeFrame({ jsonrpc: "2.0", id: streamId, method: "gateway.request", params: trustedGatewayInvocation(invocation, scope, true), meta: { schemaVersion: "0.1", requestId: streamId, traceId: streamId, deadlineUnixMs: Date.now() + timeoutMs, installationId } }));
    return stream;
  }

  async start(): Promise<string> {
    if (this.server !== undefined) return this.endpoint;
    if (process.platform !== "win32") {
      fs.mkdirSync(path.dirname(this.endpoint), { recursive: true });
      if (fs.existsSync(this.endpoint)) fs.rmSync(this.endpoint, { force: true });
    }
    this.server = net.createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      server.once("error", reject);
      server.listen(this.endpoint, () => { server.off("error", reject); resolve(); });
    });
    return this.endpoint;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = undefined;
    if (server !== undefined) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (process.platform !== "win32" && fs.existsSync(this.endpoint)) fs.rmSync(this.endpoint, { force: true });
    this.credentials.clear();
  }

  private accept(socket: net.Socket): void {
    const decoder = new FrameDecoder();
    const state: ConnectionState = { requestIds: new Set(), pending: new Map(), streams: new Map() };
    const connection = { socket, state };
    this.sockets.add(socket);
    this.connectionStates.set(socket, state);
    socket.on("close", () => {
      this.sockets.delete(socket);
      this.connectionStates.delete(socket);
      for (const pending of state.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Plugin worker disconnected")); }
      state.pending.clear();
      for (const entry of state.streams.values()) { clearTimeout(entry.timer); entry.stream.fail(new Error("Plugin worker disconnected")); }
      state.streams.clear();
    });
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk: Buffer) => {
      try {
        for (const message of decoder.push(chunk)) {
          if (this.handleResponse(state, message)) continue;
          this.handle(socket, state, message);
        }
      } catch (error) {
        this.deny(socket, error);
      }
    });
  }

  private readonly connectionStates = new Map<net.Socket, ConnectionState>();

  private *connections(): Generator<{ socket: net.Socket; state: ConnectionState }> {
    for (const [socket, state] of this.connectionStates) yield { socket, state };
  }

  private handleResponse(state: ConnectionState, message: unknown): boolean {
    if (typeof message === "object" && message !== null && (message as { method?: unknown }).method === "gateway.responseStart") {
      const params = (message as { params?: { id?: unknown; status?: unknown; headers?: unknown } }).params;
      if (typeof params?.id !== "string" || typeof params.status !== "number") return true;
      const entry = state.streams.get(params.id);
      if (entry !== undefined) entry.stream.begin(params.headers === undefined ? { status: params.status } : { status: params.status, headers: params.headers as Record<string, string> });
      return true;
    }
    if (typeof message === "object" && message !== null && (message as { method?: unknown }).method === "gateway.responseChunk") {
      const params = (message as { params?: { id?: unknown; sequence?: unknown; data?: unknown } }).params;
      if (typeof params?.id !== "string" || typeof params.sequence !== "number" || typeof params.data !== "string") return true;
      const entry = state.streams.get(params.id);
      if (entry === undefined) return true;
      if (entry.expectedSequence !== params.sequence) { clearTimeout(entry.timer); state.streams.delete(params.id); entry.stream.fail(new Error("Gateway stream sequence mismatch")); return true; }
      entry.expectedSequence += 1; entry.stream.push(Buffer.from(params.data, "base64"));
      return true;
    }
    if (typeof message === "object" && message !== null && (message as { method?: unknown }).method === "gateway.responseEnd") {
      const id = ((message as { params?: { id?: unknown } }).params)?.id;
      if (typeof id === "string") { const entry = state.streams.get(id); if (entry !== undefined) { clearTimeout(entry.timer); entry.stream.end(); state.streams.delete(id); } }
      return true;
    }
    if (typeof message !== "object" || message === null || (message as { jsonrpc?: unknown }).jsonrpc !== "2.0" || typeof (message as { id?: unknown }).id !== "string") return false;
    const id = (message as { id: string }).id;
    const pending = state.pending.get(id);
    const response = message as { result?: unknown; error?: { message?: string } };
    if (pending === undefined) {
      const stream = state.streams.get(id);
      if (stream === undefined) return false;
      clearTimeout(stream.timer);
      state.streams.delete(id);
      if (response.error !== undefined) stream.stream.fail(new Error(response.error.message ?? "Plugin gateway request failed"));
      else {
        const result = response.result as { status?: unknown; headers?: unknown; body?: unknown };
        const status = typeof result?.status === "number" ? result.status : 200;
        const headers = result?.headers as Record<string, string> | undefined;
        stream.stream.begin(headers === undefined ? { status } : { status, headers });
        if (result?.body !== undefined) stream.stream.push(Buffer.from(typeof result.body === "string" ? result.body : JSON.stringify(result.body)));
        stream.stream.end();
      }
      return true;
    }
    state.pending.delete(id);
    clearTimeout(pending.timer);
    if (response.error !== undefined) pending.reject(new Error(response.error.message ?? "Plugin gateway request failed"));
    else pending.resolve(response.result);
    return true;
  }

  private handle(socket: net.Socket, state: ConnectionState, message: unknown): void {
    try {
      validateWorkerRequest(message);
      const request = message as RpcRequest;
      if (request.id !== undefined) {
        if (state.requestIds.has(request.id)) throw new CmhError({ code: "CMH.PROTOCOL.INVALID_FRAME", messageKey: "errors.protocol.invalidFrame", retryable: false, diagnosticId: "diag_broker_duplicate_id" });
        state.requestIds.add(request.id);
      }
      if (state.scope === undefined) return this.handshake(socket, state, request);
      if (request.meta.installationId !== state.installationId || !this.options.installationEnabled(state.installationId)) throw new CmhError({ code: "CMH.PROTOCOL.HANDSHAKE_DENIED", messageKey: "errors.protocol.handshakeDenied", retryable: false, diagnosticId: "diag_broker_installation" });
      if (request.method === "lifecycle.ready" || request.method === "health.heartbeat") return this.respond(socket, request, { accepted: true });
      const result = this.options.onWorkerRequest?.(request, state.scope!);
      if (result instanceof Promise) void result.then((value) => this.respond(socket, request, value)).catch((error: unknown) => this.deny(socket, error));
      else this.respond(socket, request, result ?? { accepted: true });
    } catch (error) {
      this.deny(socket, error);
    }
  }

  private handshake(socket: net.Socket, state: ConnectionState, request: RpcRequest): void {
    if (request.method === "broker.hello") {
      if (!this.options.installationEnabled(request.meta.installationId)) throw new CmhError({ code: "CMH.PROTOCOL.HANDSHAKE_DENIED", messageKey: "errors.protocol.handshakeDenied", retryable: false, diagnosticId: "diag_broker_disabled" });
      state.installationId = request.meta.installationId;
      state.nonce = crypto.randomBytes(24).toString("base64url");
      this.respond(socket, request, { type: "broker.challenge", nonce: state.nonce, schemaVersion: "0.1" });
      return;
    }
    if (request.method !== "worker.prove" || state.nonce === undefined || state.installationId !== request.meta.installationId) throw new CmhError({ code: "CMH.PROTOCOL.HANDSHAKE_DENIED", messageKey: "errors.protocol.handshakeDenied", retryable: false, diagnosticId: "diag_broker_order" });
    const credential = typeof (request.params as { runtimeCredential?: unknown } | undefined)?.runtimeCredential === "string" ? (request.params as { runtimeCredential: string }).runtimeCredential : undefined;
    const record = credential === undefined ? undefined : this.credentials.get(credential);
    if (record === undefined || record.expiresAt < Date.now() || record.scope.installationId !== state.installationId || !this.options.installationEnabled(state.installationId)) throw new CmhError({ code: "CMH.PROTOCOL.HANDSHAKE_DENIED", messageKey: "errors.protocol.handshakeDenied", retryable: false, diagnosticId: "diag_broker_credential" });
    this.credentials.delete(credential!);
    state.scope = record.scope;
    this.respond(socket, request, { type: "broker.welcome", schemaVersion: "0.1", context: workerContext(record.scope) });
    for (const wake of this.connectionWaiters) wake();
  }

  private hasWorker(installationId: string, userId: string): boolean {
    return [...this.connections()].some((candidate) => candidate.state.scope?.installationId === installationId && candidate.state.scope.userId === userId);
  }

  private respond(socket: net.Socket, request: RpcRequest, result: unknown): void {
    if (request.id === undefined || socket.destroyed) return;
    const response: RpcResponse = { jsonrpc: "2.0", id: request.id, result, meta: { schemaVersion: "0.1", requestId: request.meta.requestId, traceId: request.meta.traceId } };
    socket.write(encodeFrame(response));
  }

  private deny(socket: net.Socket, error: unknown): void {
    if (!socket.destroyed) socket.end(encodeFrame({ jsonrpc: "2.0", error: errorShape(error) }));
  }
}
