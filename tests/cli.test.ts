import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseCli } from "../src/cli.js";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("CLI executes through npm's executable symlink", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ack-cli-"));
  try {
    const executable = join(directory, "ack-receipts");
    await symlink(new URL("../src/cli.ts", import.meta.url), executable);
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", executable, "--help"],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /On-chain delivery receipts/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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
