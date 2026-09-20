import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { CmhError, encodeFrame, FrameDecoder, validateWorkerRequest, type RpcRequest, type RpcResponse, type ScopeContext } from "@carmediahub/sdk";

export interface RuntimeCredentialScope extends ScopeContext {
  locale: "en" | "zh-CN" | "ko";
  policyVersion: number;
}

export interface RuntimeBrokerOptions {
  dataDir: string;
  endpoint?: string;
  credentialTtlMs?: number;
  installationEnabled(installationId: string): boolean;
  onWorkerRequest?(request: RpcRequest, scope: RuntimeCredentialScope): Promise<unknown> | unknown;
}

interface CredentialRecord {
  expiresAt: number;
  scope: RuntimeCredentialScope;
}

interface ConnectionState {
  installationId?: string;
  nonce?: string;
  scope?: RuntimeCredentialScope;
  requestIds: Set<string>;
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

  constructor(private readonly options: RuntimeBrokerOptions) {
    this.endpoint = options.endpoint ?? defaultEndpoint(options.dataDir);
  }

  issueCredential(scope: RuntimeCredentialScope): string {
    if (!this.options.installationEnabled(scope.installationId)) throw new Error("Plugin installation is not enabled");
    const credential = crypto.randomBytes(32).toString("base64url");
    this.credentials.set(credential, { scope, expiresAt: Date.now() + (this.options.credentialTtlMs ?? 60_000) });
    return credential;
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
    const state: ConnectionState = { requestIds: new Set() };
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk: Buffer) => {
      try {
        for (const message of decoder.push(chunk)) this.handle(socket, state, message);
      } catch (error) {
        this.deny(socket, error);
      }
    });
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
    this.respond(socket, request, { type: "broker.welcome", schemaVersion: "0.1", context: { locale: record.scope.locale, policyVersion: record.scope.policyVersion } });
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
