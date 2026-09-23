import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { RemoteWebDavProvider } from "./remote-webdav-provider.js";

test("WebDAV provider keeps credentials and upstream paths inside Core", async () => {
  const server = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer fixture-secret");
    if (request.method === "PROPFIND") {
      response.writeHead(207, { "content-type": "application/xml" });
      response.end("<?xml version=\"1.0\"?><multistatus><response><href>/dav/</href><propstat><prop><resourcetype><collection/></resourcetype></prop></propstat></response><response><href>/dav/trip.mp4</href><propstat><prop><displayname>trip.mp4</displayname><getcontentlength>5</getcontentlength><getcontenttype>video/mp4</getcontenttype></prop></propstat></response></multistatus>");
      return;
    }
    if (request.method === "HEAD") { response.writeHead(200, { "content-type": "video/mp4", "content-length": "5" }); response.end(); return; }
    if (request.method === "GET") { if (request.headers.range === "bytes=0-0") { response.writeHead(206, { "content-type": "video/mp4", "content-range": "bytes 1-1/5", "content-length": "1" }); response.end("r"); return; } if (request.headers.range !== "bytes=1-3") { response.writeHead(200, { "content-type": "video/mp4", "content-length": "5" }); response.end("ripped"); return; } response.writeHead(206, { "content-type": "video/mp4", "content-range": "bytes 1-3/5", "content-length": "3" }); response.end("rip"); return; }
    response.writeHead(405); response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  const scope = { organizationId: "org", userId: "user", deviceId: "vehicle", installationId: "plugin" };
  const provider = new RemoteWebDavProvider(
    (name, installationId) => name === "dav" && installationId === "plugin" ? { endpoint: `http://127.0.0.1:${(address as { port: number }).port}` } : undefined,
    (_scope, ref) => ref === "cred_fixture" ? { name: "authorization", value: "Bearer fixture-secret" } : undefined
  );
  try {
    const source = provider.register(scope, { binding: "dav", rootPath: "/dav/", credentialRef: "cred_fixture" });
    const listing = await provider.list(scope, source.sourceHandle);
    assert.equal(listing.items.length, 1);
    assert.equal(listing.items[0]?.name, "trip.mp4");
    assert.equal(listing.items[0]?.contentType, "video/mp4");
    assert.equal("href" in (listing.items[0] ?? {}), false);
    assert.deepEqual(await provider.health(scope, source.sourceHandle), { healthy: true, status: "ok", diagnostic: "none" });
    const playback = await provider.createPlayback(scope, source.sourceHandle, listing.items[0]!.itemHandle);
    assert.deepEqual(await provider.probe(scope, source.sourceHandle, listing.items[0]!.itemHandle), { sourceHandle: source.sourceHandle, itemHandle: listing.items[0]!.itemHandle, contentType: "video/mp4", size: 5, seekable: true, availableModes: ["direct-range"], recommendedMode: "direct-range" });
    assert.equal(Buffer.from((await provider.read(scope, playback.sessionId, 1, 3)).data, "base64").toString(), "rip");
    await assert.rejects(() => provider.read(scope, playback.sessionId, 0, 0));
    await assert.rejects(() => provider.list({ ...scope, userId: "other" }, source.sourceHandle));
    assert.throws(() => provider.register(scope, { binding: "dav", rootPath: "/dav/../private" }));
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
