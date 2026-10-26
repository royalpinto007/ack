import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createApp } from "../src/app.js";
import { readConfig } from "../src/config.js";

test("dashboard API enforces local access and cannot sign or accept writes", async (t) => {
  const server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const health = await fetch(`${url}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).mode, "read-only");
  assert.match(
    health.headers.get("content-security-policy") ?? "",
    /frame-ancestors 'none'/,
  );
  assert.equal(health.headers.get("cache-control"), "no-store");
  for (const headers of [
    new Headers({ Origin: "https://evil.example" }),
    new Headers({ "Sec-Fetch-Site": "cross-site" }),
  ]) {
    const response = await fetch(`${url}/api/receipts`, { headers });
    assert.equal(response.status, 403);
  }
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await fetch(`${url}/api/receipts`, { method });
    assert.equal(response.status, 405);
    assert.equal((await response.json()).error.code, "READ_ONLY");
  }
  assert.equal((await fetch(`${url}/api/receipts/not-an-address`)).status, 400);
  assert.equal((await fetch(`${url}/api/no-such-route`)).status, 404);
});

test("configuration refuses Mainnet and malformed ports", () => {
  assert.equal(readConfig({}).port, 4440);
  assert.equal(readConfig({ ACK_NETWORK: "devnet" }).network, "devnet");
  for (const environment of [
    { PORT: "4440junk" },
    { PORT: "0" },
    { PORT: "65536" },
    { ACK_NETWORK: "mainnet-beta" },
    { ACK_PROGRAM_ID: "invalid" },
  ])
    assert.throws(() => readConfig(environment));
});
