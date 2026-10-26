import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { before, describe, test } from "node:test";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type TransactionError,
} from "@solana/web3.js";
import { loadReceiptIdl, ReceiptClient } from "../../src/client/index.js";

const programId = new PublicKey(loadReceiptIdl().address);
const connection = new Connection("http://127.0.0.1:8899", {
  commitment: "confirmed",
  confirmTransactionInitialTimeout: 30_000,
});
const client = Keypair.generate();
const provider = Keypair.generate();
const attacker = Keypair.generate();
const otherClient = Keypair.generate();
let sdk: ReceiptClient;
let transactionCounter = 0;

function hash(value: string = randomUUID()): Buffer {
  return createHash("sha256").update(value).digest();
}

function derive(clientAddress: PublicKey, requestHash: Uint8Array): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("receipt"), clientAddress.toBuffer(), requestHash],
    programId,
  )[0];
}

async function createInstruction(
  requestHash: Uint8Array,
  clientAddress = client.publicKey,
  providerAddress = provider.publicKey,
  receipt = derive(clientAddress, requestHash),
): Promise<TransactionInstruction> {
  const create = sdk.program.methods.createReceipt;
  assert.ok(create, "compiled IDL must expose create_receipt");
  return create([...requestHash], providerAddress)
    .accountsStrict({
      receipt,
      client: clientAddress,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

async function deliverInstruction(
  receipt: PublicKey,
  providerAddress = provider.publicKey,
  responseHash: Uint8Array = hash(),
): Promise<TransactionInstruction> {
  const deliver = sdk.program.methods.markDelivered;
  assert.ok(deliver, "compiled IDL must expose mark_delivered");
  return deliver([...responseHash])
    .accountsStrict({ receipt, provider: providerAddress })
    .instruction();
}

async function acknowledgeInstruction(
  receipt: PublicKey,
  clientAddress = client.publicKey,
): Promise<TransactionInstruction> {
  const acknowledge = sdk.program.methods.acknowledge;
  assert.ok(acknowledge, "compiled IDL must expose acknowledge");
  return acknowledge()
    .accountsStrict({ receipt, client: clientAddress })
    .instruction();
}

class ConfirmedProgramError extends Error {
  constructor(
    readonly transactionError: TransactionError,
    readonly logs: string[],
  ) {
    super(
      `Confirmed transaction failed: ${JSON.stringify(transactionError)}\n${logs.join("\n")}`,
    );
  }
}

/** Send signed transactions to the validator, including negative cases, without preflight shortcuts. */
async function submit(
  instructions: TransactionInstruction[],
  payer = client,
  extraSigners: Keypair[] = [],
): Promise<string> {
  const latest = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({
    ...latest,
    feePayer: payer.publicKey,
  }).add(
    // Different signed bytes ensure a duplicate confirmation exercises program state, not RPC replay caching.
    ComputeBudgetProgram.setComputeUnitLimit({
      units: 100_000 + ++transactionCounter,
    }),
    ...instructions,
  );
  const signers = new Map(
    [payer, ...extraSigners].map((signer) => [
      signer.publicKey.toBase58(),
      signer,
    ]),
  );
  transaction.sign(...signers.values());
  const signature = await connection.sendRawTransaction(
    transaction.serialize(),
    {
      skipPreflight: true,
      maxRetries: 0,
    },
  );
  const confirmed = await connection.confirmTransaction(
    { ...latest, signature },
    "confirmed",
  );
  if (confirmed.value.err) {
    let result = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 1,
    });
    // The ledger's transaction-history index can trail the commitment notification briefly.
    for (let attempt = 0; result === null && attempt < 10; attempt++) {
      await delay(100);
      result = await connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 1,
      });
    }
    assert.ok(
      result?.meta,
      "validator must expose transaction history for confirmed failures",
    );
    assert.deepEqual(result.meta.err, confirmed.value.err);
    throw new ConfirmedProgramError(
      confirmed.value.err,
      result.meta.logMessages ?? [],
    );
  }
  return signature;
}

async function rejectInstruction(
  instructions: TransactionInstruction[],
  payer: Keypair,
  code: number,
  options: {
    unchanged?: PublicKey[];
    absent?: PublicKey[];
    instructionIndex?: number;
    errorName?: string;
    extraSigners?: Keypair[];
  } = {},
): Promise<ConfirmedProgramError> {
  const snapshots = await Promise.all(
    (options.unchanged ?? []).map(async (address) => {
      const account = await connection.getAccountInfo(address, "confirmed");
      assert.ok(
        account,
        "unchanged receipt must exist before the rejected transaction",
      );
      return { address, data: account.data, owner: account.owner.toBase58() };
    }),
  );
  for (const address of options.absent ?? []) {
    assert.equal(await connection.getAccountInfo(address, "confirmed"), null);
  }

  let rejection: ConfirmedProgramError | undefined;
  try {
    await submit(instructions, payer, options.extraSigners);
  } catch (error) {
    assert.ok(
      error instanceof ConfirmedProgramError,
      "failure must come from an executed on-chain instruction",
    );
    rejection = error;
  }
  assert.ok(rejection, "transaction must be rejected by the program");
  assert.deepEqual(rejection.transactionError, {
    InstructionError: [options.instructionIndex ?? 1, { Custom: code }],
  });
  if (options.errorName) {
    assert.ok(
      rejection.logs.some((line) =>
        line.includes(
          `Error Code: ${options.errorName}. Error Number: ${code}.`,
        ),
      ),
      `expected Anchor error ${options.errorName} (${code}), got ${rejection.logs.join("\n")}`,
    );
  }
  for (const snapshot of snapshots) {
    const after = await connection.getAccountInfo(
      snapshot.address,
      "confirmed",
    );
    assert.ok(after);
    assert.deepEqual(
      after.data,
      snapshot.data,
      "a rejected transaction must preserve every receipt byte",
    );
    assert.equal(after.owner.toBase58(), snapshot.owner);
  }
  for (const address of options.absent ?? []) {
    assert.equal(
      await connection.getAccountInfo(address, "confirmed"),
      null,
      "failed creation must leave no account",
    );
  }
  return rejection;
}

async function createFixture(): Promise<PublicKey> {
  const requestHash = hash();
  const receipt = derive(client.publicKey, requestHash);
  await submit([await createInstruction(requestHash)]);
  return receipt;
}

async function deliveredFixture(): Promise<PublicKey> {
  const receipt = await createFixture();
  await submit([await deliverInstruction(receipt)], provider);
  return receipt;
}

async function chainTimestamp(): Promise<number> {
  const account = await connection.getAccountInfo(
    SYSVAR_CLOCK_PUBKEY,
    "confirmed",
  );
  assert.ok(account);
  return Number(account.data.readBigInt64LE(32));
}

function withoutSigner(
  instruction: TransactionInstruction,
  authority: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: instruction.programId,
    data: instruction.data,
    keys: instruction.keys.map((meta) =>
      meta.pubkey.equals(authority) ? { ...meta, isSigner: false } : meta,
    ),
  });
}

describe(
  "compiled ack program on a real local validator",
  { concurrency: false, timeout: 180_000 },
  () => {
    before(async () => {
      sdk = new ReceiptClient({ network: "localnet", connection });
      assert.ok(sdk.programId.equals(programId));
      const executable = await connection.getAccountInfo(
        programId,
        "confirmed",
      );
      assert.ok(
        executable?.executable,
        "test harness must load the actual compiled SBF program",
      );
      for (const signer of [client, provider, attacker, otherClient]) {
        const signature = await connection.requestAirdrop(
          signer.publicKey,
          1_000_000_000,
        );
        const latest = await connection.getLatestBlockhash("confirmed");
        const confirmation = await connection.confirmTransaction(
          { ...latest, signature },
          "confirmed",
        );
        assert.equal(confirmation.value.err, null);
      }
    });

    test("creates a rent-exempt PDA with immutable identities, exact request hash and chain time", async () => {
      const requestHash = hash("unique request: " + randomUUID());
      const expected = derive(client.publicKey, requestHash);
      assert.ok(
        sdk.deriveReceipt(client.publicKey, requestHash)[0].equals(expected),
      );
      const before = await chainTimestamp();
      await submit([await createInstruction(requestHash)]);
      const after = await chainTimestamp();
      const receipt = await sdk.inspect(expected);
      assert.equal(receipt.address, expected.toBase58());
      assert.equal(receipt.version, 1);
      assert.equal(receipt.client, client.publicKey.toBase58());
      assert.equal(receipt.provider, provider.publicKey.toBase58());
      assert.equal(receipt.requestHash, requestHash.toString("hex"));
      assert.equal(receipt.responseHash, null);
      assert.equal(receipt.status, "created");
      assert.equal(receipt.deliveredAt, null);
      assert.equal(receipt.acknowledgedAt, null);
      assert.ok(receipt.createdAt >= before && receipt.createdAt <= after);
      const account = await connection.getAccountInfo(expected, "confirmed");
      assert.ok(account);
      assert.ok(account.owner.equals(programId));
      assert.equal(account.data.length, 165);
      assert.ok(
        account.lamports >=
          (await connection.getMinimumBalanceForRentExemption(
            account.data.length,
          )),
      );
    });

    test("SDK completes the signed lifecycle, reads exact commitments, and filters by client", async () => {
      const requestHash = hash();
      const responseText =
        "Private API response with a unique identifier: " + randomUUID();
      const responseHash = hash(responseText);
      const created = await sdk.createReceipt(
        client,
        provider.publicKey,
        requestHash,
      );
      const address = new PublicKey(created.receipt.address);
      const beforeDelivery = await chainTimestamp();
      const delivered = await sdk.markDelivered(
        provider,
        address,
        responseHash,
      );
      const afterDelivery = await chainTimestamp();
      assert.equal(delivered.receipt.status, "delivered");
      assert.equal(
        delivered.receipt.responseHash,
        responseHash.toString("hex"),
      );
      assert.equal(delivered.receipt.acknowledgedAt, null);
      assert.ok(delivered.receipt.deliveredAt !== null);
      assert.ok(
        delivered.receipt.deliveredAt >= beforeDelivery &&
          delivered.receipt.deliveredAt <= afterDelivery,
      );
      const beforeAcknowledgment = await chainTimestamp();
      const acknowledged = await sdk.acknowledge(client, address);
      const afterAcknowledgment = await chainTimestamp();
      assert.equal(acknowledged.receipt.status, "acknowledged");
      assert.equal(
        acknowledged.receipt.requestHash,
        requestHash.toString("hex"),
      );
      assert.equal(
        acknowledged.receipt.responseHash,
        responseHash.toString("hex"),
      );
      assert.equal(acknowledged.receipt.client, created.receipt.client);
      assert.equal(acknowledged.receipt.provider, created.receipt.provider);
      assert.equal(acknowledged.receipt.createdAt, created.receipt.createdAt);
      assert.equal(
        acknowledged.receipt.deliveredAt,
        delivered.receipt.deliveredAt,
      );
      assert.ok(acknowledged.receipt.acknowledgedAt !== null);
      assert.ok(
        acknowledged.receipt.acknowledgedAt >= beforeAcknowledgment &&
          acknowledged.receipt.acknowledgedAt <= afterAcknowledgment,
      );
      assert.ok(
        acknowledged.receipt.acknowledgedAt >= delivered.receipt.deliveredAt,
      );
      const account = await connection.getAccountInfo(address, "confirmed");
      assert.ok(account);
      assert.equal(
        account.data.includes(Buffer.from(responseText)),
        false,
        "response plaintext must stay off-chain",
      );
      const foreign = await sdk.createReceipt(
        otherClient,
        provider.publicKey,
        hash(),
      );
      const filtered = await sdk.list(client.publicKey);
      assert.ok(filtered.some((entry) => entry.address === address.toBase58()));
      assert.ok(
        filtered.every((entry) => entry.client === client.publicKey.toBase58()),
      );
      assert.equal(
        filtered.some((entry) => entry.address === foreign.receipt.address),
        false,
      );
      const otherReceipts = await sdk.list(otherClient.publicKey);
      assert.ok(
        otherReceipts.some(
          (entry) => entry.address === foreign.receipt.address,
        ),
      );
      assert.ok(
        otherReceipts.every(
          (entry) => entry.client === otherClient.publicKey.toBase58(),
        ),
      );
      assert.equal((await sdk.list(Keypair.generate().publicKey)).length, 0);
    });

    test("duplicate creation cannot replace the nominated provider", async () => {
      const requestHash = hash();
      const receipt = derive(client.publicKey, requestHash);
      await submit([await createInstruction(requestHash)]);
      const error = await rejectInstruction(
        [
          await createInstruction(
            requestHash,
            client.publicKey,
            attacker.publicKey,
          ),
        ],
        client,
        0,
        { unchanged: [receipt] },
      );
      assert.ok(error.logs.some((line) => /already in use/i.test(line)));
      assert.equal(
        (await sdk.inspect(receipt)).provider,
        provider.publicKey.toBase58(),
      );
    });

    test("an unrelated signer cannot claim delivery", async () => {
      const receipt = await createFixture();
      await rejectInstruction(
        [await deliverInstruction(receipt, attacker.publicKey)],
        attacker,
        6004,
        { unchanged: [receipt], errorName: "UnauthorizedProvider" },
      );
    });

    test("the client cannot sign in the provider role", async () => {
      const receipt = await createFixture();
      await rejectInstruction(
        [await deliverInstruction(receipt, client.publicKey)],
        client,
        6004,
        { unchanged: [receipt], errorName: "UnauthorizedProvider" },
      );
    });

    test("an unrelated signer cannot acknowledge delivery", async () => {
      const receipt = await deliveredFixture();
      await rejectInstruction(
        [await acknowledgeInstruction(receipt, attacker.publicKey)],
        attacker,
        6005,
        { unchanged: [receipt], errorName: "UnauthorizedClient" },
      );
    });

    test("the provider cannot sign in the client role", async () => {
      const receipt = await deliveredFixture();
      await rejectInstruction(
        [await acknowledgeInstruction(receipt, provider.publicKey)],
        provider,
        6005,
        { unchanged: [receipt], errorName: "UnauthorizedClient" },
      );
    });

    test("the client cannot acknowledge before the provider's delivery claim", async () => {
      const receipt = await createFixture();
      await rejectInstruction(
        [await acknowledgeInstruction(receipt)],
        client,
        6007,
        { unchanged: [receipt], errorName: "NotDelivered" },
      );
    });

    test("a second delivery claim cannot overwrite the response hash or timestamp", async () => {
      const receipt = await deliveredFixture();
      const original = await sdk.inspect(receipt);
      await rejectInstruction(
        [
          await deliverInstruction(
            receipt,
            provider.publicKey,
            hash("replacement response"),
          ),
        ],
        provider,
        6006,
        { unchanged: [receipt], errorName: "AlreadyDelivered" },
      );
      assert.equal(
        (await sdk.inspect(receipt)).responseHash,
        original.responseHash,
      );
    });

    test("identical repeated delivery still executes and fails the duplicate guard", async () => {
      const receipt = await createFixture();
      const responseHash = hash();
      const instruction = await deliverInstruction(
        receipt,
        provider.publicKey,
        responseHash,
      );
      await submit([instruction], provider);
      await rejectInstruction([instruction], provider, 6006, {
        unchanged: [receipt],
        errorName: "AlreadyDelivered",
      });
    });

    test("a second acknowledgment cannot alter the final receipt", async () => {
      const receipt = await deliveredFixture();
      const instruction = await acknowledgeInstruction(receipt);
      await submit([instruction]);
      await rejectInstruction([instruction], client, 6008, {
        unchanged: [receipt],
        errorName: "AlreadyAcknowledged",
      });
    });

    test("the provider cannot reopen an acknowledged receipt", async () => {
      const receipt = await deliveredFixture();
      await submit([await acknowledgeInstruction(receipt)]);
      await rejectInstruction(
        [await deliverInstruction(receipt)],
        provider,
        6006,
        { unchanged: [receipt], errorName: "AlreadyDelivered" },
      );
    });

    for (const invalid of [
      {
        name: "a zero request hash",
        hash: Buffer.alloc(32),
        provider: provider.publicKey,
        code: 6002,
        error: "EmptyRequestHash",
      },
      {
        name: "a default provider",
        hash: hash(),
        provider: PublicKey.default,
        code: 6000,
        error: "InvalidProvider",
      },
      {
        name: "the same client and provider",
        hash: hash(),
        provider: client.publicKey,
        code: 6001,
        error: "SameParticipant",
      },
    ]) {
      test(`creation rejects ${invalid.name} and leaves no receipt`, async () => {
        const receipt = derive(client.publicKey, invalid.hash);
        await rejectInstruction(
          [
            await createInstruction(
              invalid.hash,
              client.publicKey,
              invalid.provider,
            ),
          ],
          client,
          invalid.code,
          { absent: [receipt], errorName: invalid.error },
        );
      });
    }

    test("a provider cannot commit a zero response hash", async () => {
      const receipt = await createFixture();
      await rejectInstruction(
        [
          await deliverInstruction(
            receipt,
            provider.publicKey,
            Buffer.alloc(32),
          ),
        ],
        provider,
        6003,
        { unchanged: [receipt], errorName: "EmptyResponseHash" },
      );
    });

    test("two clients may use the same request hash without sharing an account", async () => {
      const requestHash = hash();
      const first = derive(client.publicKey, requestHash);
      const second = derive(otherClient.publicKey, requestHash);
      assert.equal(first.equals(second), false);
      await submit([await createInstruction(requestHash)]);
      await submit(
        [await createInstruction(requestHash, otherClient.publicKey)],
        otherClient,
      );
      assert.equal(
        (await sdk.inspect(first)).client,
        client.publicKey.toBase58(),
      );
      assert.equal(
        (await sdk.inspect(second)).client,
        otherClient.publicKey.toBase58(),
      );
      assert.equal(
        (await sdk.inspect(first)).requestHash,
        (await sdk.inspect(second)).requestHash,
      );
    });

    test("creation rejects a substituted PDA", async () => {
      const requestHash = hash();
      const correct = derive(client.publicKey, requestHash);
      const wrong = Keypair.generate().publicKey;
      await rejectInstruction(
        [
          await createInstruction(
            requestHash,
            client.publicKey,
            provider.publicKey,
            wrong,
          ),
        ],
        client,
        2006,
        { absent: [correct, wrong], errorName: "ConstraintSeeds" },
      );
    });

    test("a matching provider address without its signer flag is rejected", async () => {
      const receipt = await createFixture();
      const instruction = withoutSigner(
        await deliverInstruction(receipt),
        provider.publicKey,
      );
      await rejectInstruction([instruction], client, 3010, {
        unchanged: [receipt],
        errorName: "AccountNotSigner",
      });
    });

    test("a matching client address without its signer flag is rejected", async () => {
      const receipt = await deliveredFixture();
      const instruction = withoutSigner(
        await acknowledgeInstruction(receipt),
        client.publicKey,
      );
      await rejectInstruction([instruction], provider, 3010, {
        unchanged: [receipt],
        errorName: "AccountNotSigner",
      });
    });

    test("an invalid acknowledgment atomically rolls back receipt creation in the same transaction", async () => {
      const requestHash = hash();
      const receipt = derive(client.publicKey, requestHash);
      await rejectInstruction(
        [
          await createInstruction(requestHash),
          await acknowledgeInstruction(receipt),
        ],
        client,
        6007,
        { absent: [receipt], instructionIndex: 2, errorName: "NotDelivered" },
      );
    });

    test("a later unauthorized instruction atomically rolls back a valid delivery claim", async () => {
      const receipt = await createFixture();
      await rejectInstruction(
        [
          await deliverInstruction(receipt),
          await acknowledgeInstruction(receipt, attacker.publicKey),
        ],
        provider,
        6005,
        {
          unchanged: [receipt],
          instructionIndex: 2,
          extraSigners: [attacker],
          errorName: "UnauthorizedClient",
        },
      );
    });

    test("truncated instruction data cannot mutate a receipt", async () => {
      const receipt = await createFixture();
      const instruction = await deliverInstruction(receipt);
      instruction.data = instruction.data.subarray(
        0,
        instruction.data.length - 1,
      );
      await rejectInstruction([instruction], provider, 102, {
        unchanged: [receipt],
        errorName: "InstructionDidNotDeserialize",
      });
    });
  },
);
