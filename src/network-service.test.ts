import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { executeNetworkRequest } from "./network-service.js";

test("executes only a bound-origin request with filtered headers", async () => {
  const server = http.createServer((request, response) => { assert.equal(request.headers.authorization, undefined); assert.equal(request.headers.range, "bytes=0-1"); response.writeHead(206, { "content-type": "text/plain" }); response.end("ok"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const result = await executeNetworkRequest({ binding: "local-service", method: "GET", path: "/media", headers: { range: "bytes=0-1", authorization: "secret" } }, () => ({ endpoint: `http://127.0.0.1:${address.port}` }));
    assert.equal(result.status, 206);
    assert.equal(Buffer.from(result.bodyBase64!, "base64").toString(), "ok");
    await assert.rejects(() => executeNetworkRequest({ binding: "local-service", method: "GET", path: "../secret" }, () => ({ endpoint: `http://127.0.0.1:${address.port}` })));
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});
