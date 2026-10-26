import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseCli } from "../src/cli.js";

test("CLI requires explicit signing keys and exactly one commitment source", () => {
  assert.throws(
    () => parseCli(["create", "--request-id", "123", "--provider", "abc"]),
    /keypair/,
  );
  assert.throws(
    () => parseCli(["deliver", "--receipt", "abc", "--keypair", "key.json"]),
    /response-file.*response-hash/,
  );
  assert.throws(
    () =>
      parseCli([
        "pda",
        "--client",
        "abc",
        "--request-id",
        "1",
        "--request-hash",
        "a".repeat(64),
      ]),
    /request-id.*request-hash/,
  );
});

test("CLI rejects Mainnet, unknown options, positional payloads and ambiguous flags", () => {
  for (const args of [
    ["toString"],
    ["list", "--network", "mainnet-beta"],
    ["list", "--rpc", "https://example.com"],
    ["inspect", "plaintext"],
    ["list", "--network", "localnet", "--network", "devnet"],
    ["list", "--keypair", "key.json"],
  ]) {
    assert.throws(() => parseCli(args));
  }
});

test("help and local hashing work without an IDL or running validator", () => {
  const cli = new URL("../src/cli.ts", import.meta.url);
  const help = spawnSync(
    process.execPath,
    ["--import", "tsx", cli.pathname, "--help"],
    { encoding: "utf8" },
  );
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /create[\s\S]*deliver[\s\S]*acknowledge/);
  const hash = spawnSync(
    process.execPath,
    ["--import", "tsx", cli.pathname, "hash", "--text", "abc"],
    { encoding: "utf8" },
  );
  assert.equal(hash.status, 0, hash.stderr);
  assert.deepEqual(JSON.parse(hash.stdout), {
    algorithm: "sha256",
    hash: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  });
});

test("CLI rejects empty explicit program and participant addresses", () => {
  for (const args of [
    ["list", "--program-id", ""],
    ["list", "--client", ""],
    [
      "pda",
      "--client",
      "11111111111111111111111111111111",
      "--request-id",
      "request",
      "--program-id",
      "",
    ],
    [
      "create",
      "--provider",
      "",
      "--keypair",
      "client.json",
      "--request-id",
      "request",
    ],
  ]) {
    assert.throws(() => parseCli(args), /nonempty/);
  }
});
