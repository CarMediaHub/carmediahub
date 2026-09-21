import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { executeNetworkRequest } from "./network-service.js";

test("executes only a bound-origin request with filtered headers and redirects", async () => {
  let crossPort = 0;
  const cross = http.createServer((_request, response) => { response.end("cross"); });
  await new Promise<void>((resolve) => cross.listen(0, "127.0.0.1", resolve));
  const crossAddress = cross.address();
  assert.ok(crossAddress && typeof crossAddress !== "string");
  crossPort = crossAddress.port;
  const server = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, undefined);
    if (request.url === "/redirect") { response.writeHead(302, { location: "/media" }); response.end(); return; }
    if (request.url === "/cross") { response.writeHead(302, { location: `http://127.0.0.1:${crossPort}/` }); response.end(); return; }
    assert.equal(request.headers.range, "bytes=0-1"); response.writeHead(206, { "content-type": "text/plain" }); response.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const result = await executeNetworkRequest({ binding: "local-service", method: "GET", path: "/redirect", headers: { range: "bytes=0-1", authorization: "secret" } }, () => ({ endpoint: `http://127.0.0.1:${address.port}` }));
    assert.equal(result.status, 206);
    assert.equal(Buffer.from(result.bodyBase64!, "base64").toString(), "ok");
    await assert.rejects(() => executeNetworkRequest({ binding: "local-service", method: "GET", path: "../secret" }, () => ({ endpoint: `http://127.0.0.1:${address.port}` })));
    await assert.rejects(() => executeNetworkRequest({ binding: "local-service", method: "GET", path: "/cross" }, () => ({ endpoint: `http://127.0.0.1:${address.port}` })));
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); await new Promise<void>((resolve, reject) => cross.close((error) => error ? reject(error) : resolve())); }
});

test("limits concurrent requests per binding and releases the slot", async () => {
  let requests = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const server = http.createServer(async (_request, response) => { requests += 1; await gate; response.end("ok"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const pending = Array.from({ length: 10 }, () => executeNetworkRequest({ binding: "busy", method: "GET", path: "/" }, () => ({ endpoint: `http://127.0.0.1:${address.port}` })));
    for (let attempt = 0; attempt < 20 && requests < 10; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(requests, 10);
    await assert.rejects(() => executeNetworkRequest({ binding: "busy", method: "GET", path: "/" }, () => ({ endpoint: `http://127.0.0.1:${address.port}` })), /concurrency/);
    release();
    await Promise.all(pending);
  } finally { release(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});
