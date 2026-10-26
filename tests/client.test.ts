import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import anchor from "@anchor-lang/core";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { ReceiptClient, ReceiptStateError } from "../src/client/index.js";
import {
  hashBytes,
  hashFile,
  hashHex,
  parseHash,
  readKeypair,
} from "../src/client/inputs.js";

const { BN } = anchor;

test("hashes exact UTF-8 and file bytes with SHA-256", async () => {
  assert.equal(
    hashHex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(hashBytes("café").length, 32);
  assert.notDeepEqual(hashBytes("café"), hashBytes("cafe"));
  const directory = await mkdtemp(join(tmpdir(), "ack-input-"));
  try {
    const path = join(directory, "response.bin");
    const bytes = Buffer.from([0, 1, 128, 255, 10]);
    await writeFile(path, bytes);
    assert.deepEqual(await hashFile(path), hashBytes(bytes));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("hash parser accepts exact hex and rejects malformed or empty commitments", () => {
  const hash = hashHex("request-123");
  assert.equal(parseHash(hash.toUpperCase()).toString("hex"), hash);
  for (const invalid of [
    "",
    "aa",
    "g".repeat(64),
    "0".repeat(64),
    ` ${hash}`,
  ]) {
    assert.throws(() => parseHash(invalid), /hash/i);
  }
});

test("explicit keypair files must contain a bounded, valid 64-byte secret", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ack-key-"));
  const path = join(directory, "key.json");
  try {
    const original = Keypair.generate();
    await writeFile(path, JSON.stringify([...original.secretKey]));
    assert.equal(
      (await readKeypair(path)).publicKey.toBase58(),
      original.publicKey.toBase58(),
    );
    for (const value of [
      [],
      Array(64).fill(256),
      Array(64).fill(0),
      { secret: "wrong" },
    ]) {
      await writeFile(path, JSON.stringify(value));
      await assert.rejects(readKeypair(path), /keypair/i);
    }
    await writeFile(path, " ".repeat(4097));
    await assert.rejects(readKeypair(path), /keypair/i);
    await assert.rejects(readKeypair(directory), /keypair/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("generated IDL builds wallet-free instructions with explicit signing roles", async () => {
  const sdk = new ReceiptClient();
  assert.equal(sdk.program.provider.wallet, undefined);
  const client = Keypair.generate().publicKey;
  const provider = Keypair.generate().publicKey;
  const request = hashBytes("offline IDL check");
  const [receipt] = sdk.deriveReceipt(client, request);
  const create = sdk.program.methods.createReceipt;
  const deliver = sdk.program.methods.markDelivered;
  const acknowledge = sdk.program.methods.acknowledge;
  assert.ok(create && deliver && acknowledge);
  const instructions = await Promise.all([
    create([...request], provider)
      .accountsStrict({
        receipt,
        client,
        systemProgram: SystemProgram.programId,
      })
      .instruction(),
    deliver([...hashBytes("response")])
      .accountsStrict({ receipt, provider })
      .instruction(),
    acknowledge().accountsStrict({ receipt, client }).instruction(),
  ]);
  assert.deepEqual(
    instructions.map((instruction) => instruction.data.length),
    [72, 40, 8],
  );
  assert.deepEqual(
    instructions.map((instruction) =>
      instruction.keys
        .filter((key) => key.isSigner)
        .map((key) => key.pubkey.toBase58()),
    ),
    [[client.toBase58()], [provider.toBase58()], [client.toBase58()]],
  );
  for (const instruction of instructions) {
    assert.ok(instruction.programId.equals(sdk.programId));
    assert.ok(instruction.keys[0]?.pubkey.equals(receipt));
    assert.equal(instruction.keys[0]?.isWritable, true);
  }
  const other = new ReceiptClient({ programId: Keypair.generate().publicKey });
  assert.equal(other.deriveReceipt(client, request)[0].equals(receipt), false);
});

test("RPC decoding preserves generated enum, hash, timestamp and PDA semantics", async () => {
  let account: {
    owner: string;
    executable: boolean;
    lamports: number;
    rentEpoch: number;
    data: [string, string];
  } | null = null;
  const connection = new Connection("http://127.0.0.1:8899", {
    fetch: async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        id: string;
        method: string;
      };
      assert.equal(request.method, "getAccountInfo");
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: { context: { slot: 1 }, value: account },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    },
  });
  const sdk = new ReceiptClient({ connection });
  const client = Keypair.generate().publicKey;
  const provider = Keypair.generate().publicKey;
  const requestHash = hashBytes("rpc fixture request");
  const responseHash = hashBytes("rpc fixture response");
  const [address, bump] = sdk.deriveReceipt(client, requestHash);
  const base = {
    version: 1,
    requestHash: [...requestHash],
    provider,
    client,
    bump,
    createdAt: new BN(1_800_000_000),
  };
  for (const status of ["created", "delivered", "acknowledged"] as const) {
    const data = await sdk.program.coder.accounts.encode("receipt", {
      ...base,
      responseHash:
        status === "created" ? Array(32).fill(0) : [...responseHash],
      deliveredAt: status === "created" ? null : new BN(1_800_000_010),
      acknowledgedAt: status === "acknowledged" ? new BN(1_800_000_020) : null,
      status: { [status]: {} },
    });
    account = {
      owner: sdk.programId.toBase58(),
      executable: false,
      lamports: 1,
      rentEpoch: 0,
      data: [data.toString("base64"), "base64"],
    };
    const view = await sdk.inspect(address);
    assert.equal(view.status, status);
    assert.equal(view.requestHash, requestHash.toString("hex"));
    assert.equal(
      view.responseHash,
      status === "created" ? null : responseHash.toString("hex"),
    );
    assert.equal(view.createdAt, 1_800_000_000);
    assert.equal(view.deliveredAt, status === "created" ? null : 1_800_000_010);
    assert.equal(
      view.acknowledgedAt,
      status === "acknowledged" ? 1_800_000_020 : null,
    );
  }
  assert.ok(account);
  await assert.rejects(
    sdk.inspect(Keypair.generate().publicKey),
    ReceiptStateError,
  );
  account.owner = PublicKey.default.toBase58();
  await assert.rejects(sdk.inspect(address), ReceiptStateError);
});
