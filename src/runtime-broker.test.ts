import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { encodeFrame, FrameDecoder, type RpcRequest } from "@carmediahub/sdk";
import { RuntimeBroker, type RuntimeCredentialScope } from "./runtime-broker.js";

const scope: RuntimeCredentialScope = {
  deploymentId: "dep_real", organizationId: "org_real", userId: "user_real", deviceId: "device_real", sessionId: "session_real", installationId: "plugin_enabled", locale: "en", policyVersion: 7
};

function request(id: string, method: string, installationId = scope.installationId, params?: unknown): RpcRequest {
  return {
    jsonrpc: "2.0", id, method, params,
    meta: {
      schemaVersion: "0.1", requestId: `request_${id}`, traceId: `trace_${id}`, deadlineUnixMs: Date.now() + 10_000, installationId,
      scope: { deploymentId: "dep_forged", organizationId: "org_forged", userId: "user_forged", deviceId: "device_forged", sessionId: "session_forged" }
    }
  };
}

async function connect(endpoint: string): Promise<{ socket: net.Socket; decoder: FrameDecoder }> {
  const socket = net.createConnection(endpoint);
  await once(socket, "connect");
  return { socket, decoder: new FrameDecoder() };
}

async function send(socket: net.Socket, decoder: FrameDecoder, message: unknown): Promise<Record<string, unknown>> {
  const response = new Promise<Record<string, unknown>>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      try {
        const messages = decoder.push(chunk);
        if (messages.length > 0) resolve(messages[0] as Record<string, unknown>);
      } catch (error) { reject(error); }
    };
    socket.once("data", onData);
    socket.once("error", reject);
  });
  socket.write(encodeFrame(message));
  return response;
}

test("Broker injects credential scope and rejects forged scope metadata", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-broker-"));
  let receivedScope: RuntimeCredentialScope | undefined;
  const broker = new RuntimeBroker({ dataDir, installationEnabled: (id) => id === scope.installationId, onWorkerRequest: (_request, context) => { receivedScope = context; return { accepted: true }; } });
  try {
    const endpoint = await broker.start();
    const credential = broker.issueCredential(scope);
    const client = await connect(endpoint);
    const challenge = await send(client.socket, client.decoder, request("hello", "broker.hello"));
    assert.equal((challenge.result as { type: string }).type, "broker.challenge");
    const welcome = await send(client.socket, client.decoder, request("prove", "worker.prove", scope.installationId, { runtimeCredential: credential }));
    assert.deepEqual(welcome.result, { type: "broker.welcome", schemaVersion: "0.1", context: { locale: "en", policyVersion: 7 } });
    await send(client.socket, client.decoder, request("ready", "lifecycle.ready"));
    await send(client.socket, client.decoder, request("event", "event.emit"));
    assert.deepEqual(receivedScope, scope);
    client.socket.end();
  } finally {
    await broker.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Broker rejects invalid credentials, disabled installations, and malformed frames", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-broker-"));
  const broker = new RuntimeBroker({ dataDir, installationEnabled: (id) => id === scope.installationId });
  try {
    const endpoint = await broker.start();
    const invalid = await connect(endpoint);
    await send(invalid.socket, invalid.decoder, request("hello", "broker.hello"));
    const denied = await send(invalid.socket, invalid.decoder, request("prove", "worker.prove", scope.installationId, { runtimeCredential: "wrong" }));
    assert.equal((denied.error as { code: string }).code, "CMH.PROTOCOL.HANDSHAKE_DENIED");

    const disabled = await connect(endpoint);
    const disabledDenied = await send(disabled.socket, disabled.decoder, request("hello", "broker.hello", "plugin_disabled"));
    assert.equal((disabledDenied.error as { code: string }).code, "CMH.PROTOCOL.HANDSHAKE_DENIED");

    const malformed = await connect(endpoint);
    const malformedError = new Promise<Record<string, unknown>>((resolve, reject) => malformed.socket.once("data", (chunk: Buffer) => {
      try { resolve(malformed.decoder.push(chunk)[0] as Record<string, unknown>); } catch (error) { reject(error); }
    }));
    malformed.socket.write(Buffer.from([0, 0, 0, 0]));
    assert.equal(((await malformedError).error as { code: string }).code, "CMH.PROTOCOL.INVALID_FRAME");
  } finally {
    await broker.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
