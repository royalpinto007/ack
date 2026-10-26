import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { ReceiptClient, hashBytes, readKeypair } from "../dist/client/index.js";

const idl = JSON.parse(
  await readFile(new URL("../idl/ack.json", import.meta.url), "utf8"),
);
export async function startLocalnet({ temporary = false } = {}) {
  await access("target/deploy/ack.so").catch(() => {
    throw new Error(
      "Compiled program missing. Install Anchor 1.2.1 and Solana 4.1.2, then run npm run program:build.",
    );
  });
  await mkdir(".ack", { recursive: true });
  try {
    const response = await fetch("http://127.0.0.1:8899", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
      signal: AbortSignal.timeout(500),
    });
    if (response.ok) throw new Error("LOCAL_RPC_IN_USE");
  } catch (error) {
    if (error.message === "LOCAL_RPC_IN_USE")
      throw new Error(
        "Port 8899 already has an RPC. Stop it before starting ack?'s isolated local validator.",
        { cause: error },
      );
  }
  const ledger = temporary
    ? await mkdtemp(resolve(".ack/test-ledger-"))
    : resolve(".ack/demo-ledger");
  const log = await open(
    join(
      resolve(".ack"),
      temporary ? "test-validator.log" : "demo-validator.log",
    ),
    "w",
    0o600,
  );
  const child = spawn(
    "solana-test-validator",
    [
      "--ledger",
      ledger,
      "--bind-address",
      "127.0.0.1",
      "--rpc-port",
      "8899",
      "--bpf-program",
      idl.address,
      resolve("target/deploy/ack.so"),
      "--quiet",
    ],
    {
      env: {
        ...process.env,
        RAYON_NUM_THREADS: "1",
        SOLANA_RAYON_THREADS: "1",
        TOKIO_WORKER_THREADS: "2",
      },
      stdio: ["ignore", log.fd, log.fd],
    },
  );
  let spawnError;
  child.on("error", (error) => {
    spawnError = error;
  });
  await log.close();
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (child.exitCode === null && child.signalCode === null && !spawnError) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    }
    if (temporary) await rm(ledger, { recursive: true, force: true });
  };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 180; attempt++) {
      if (spawnError)
        throw new Error(
          "solana-test-validator is unavailable. Install Solana CLI 4.1.2 and add it to PATH.",
        );
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(
          "The local validator exited. Check .ack/*-validator.log.",
        );
      try {
        const response = await fetch("http://127.0.0.1:8899", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
          signal: AbortSignal.timeout(750),
        });
        if ((await response.json()).result === "ok") {
          ready = true;
          break;
        }
      } catch {
        /* Wait for this newly started process, never another network. */
      }
      await new Promise((done) => setTimeout(done, 250));
    }
    if (!ready)
      throw new Error(
        "Local validator did not become ready. Check .ack/*-validator.log.",
      );
    const client = new ReceiptClient();
    const account = await client.connection.getAccountInfo(client.programId);
    if (!account?.executable)
      throw new Error(
        "The local program is missing. Stop the demo and remove only .ack/demo-ledger before rebuilding its local genesis.",
      );
    const binary = await readFile("target/deploy/ack.so");
    let deployedBinary = account.data;
    // Loader-v3 program accounts point to ProgramData: the ELF follows its fixed 45-byte metadata.
    if (
      account.owner.toBase58() === "BPFLoaderUpgradeab1e11111111111111111111111"
    ) {
      if (account.data.length !== 36 || account.data.readUInt32LE(0) !== 2)
        throw new Error("Unexpected local program account.");
      const data = await client.connection.getAccountInfo(
        new PublicKey(account.data.subarray(4, 36)),
      );
      if (
        !data ||
        !data.owner.equals(account.owner) ||
        data.data.length < 45 ||
        data.data.readUInt32LE(0) !== 3
      )
        throw new Error("Unexpected local ProgramData account.");
      deployedBinary = data.data.subarray(45);
    }
    if (!deployedBinary.equals(binary))
      throw new Error(
        "This local ledger has a different program build. Back up any receipts, stop the demo, and remove only .ack/demo-ledger to load the current build.",
      );
    return { client, stop, child, ledger };
  } catch (error) {
    await stop();
    throw error;
  }
}

export async function seedLocal(client) {
  const keys = {};
  for (const role of ["client", "provider"]) {
    const path = `.ack/${role}-keypair.json`;
    try {
      keys[role] = await readKeypair(path);
    } catch (error) {
      try {
        await access(path);
        throw error;
      } catch (missing) {
        if (missing.code !== "ENOENT") throw missing;
      }
      keys[role] = Keypair.generate();
      await writeFile(path, JSON.stringify(Array.from(keys[role].secretKey)), {
        mode: 0o600,
        flag: "wx",
      });
    }
    if (
      (await client.connection.getBalance(keys[role].publicKey)) <
      LAMPORTS_PER_SOL
    ) {
      const signature = await client.connection.requestAirdrop(
        keys[role].publicKey,
        5 * LAMPORTS_PER_SOL,
      );
      const block = await client.connection.getLatestBlockhash();
      const confirmation = await client.connection.confirmTransaction(
        { signature, ...block },
        "confirmed",
      );
      if (confirmation.value.err)
        throw new Error("Local test-SOL funding failed.");
    }
  }
  const receipts = [];
  for (const status of ["created", "delivered", "acknowledged"]) {
    const requestHash = hashBytes(`ack-demo-${status}-v1`);
    const [address] = client.deriveReceipt(keys.client.publicKey, requestHash);
    if (!(await client.connection.getAccountInfo(address)))
      await client.createReceipt(
        keys.client,
        keys.provider.publicKey,
        requestHash,
      );
    let receipt = await client.inspect(address);
    if (status !== "created" && receipt.status === "created") {
      await client.markDelivered(
        keys.provider,
        address,
        hashBytes(`ack-demo-response-${status}-v1`),
      );
      receipt = await client.inspect(address);
    }
    if (status === "acknowledged" && receipt.status === "delivered")
      await client.acknowledge(keys.client, address);
    receipts.push(await client.inspect(address));
  }
  return receipts;
}
