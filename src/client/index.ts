import { readFileSync } from "node:fs";
import { Program, type BN, type Idl } from "@anchor-lang/core";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import type { Network, ReceiptStatus, ReceiptView } from "../types.js";
import { requireHash, validatePublicKey } from "./inputs.js";

export {
  hashBytes,
  hashFile,
  hashHex,
  parseHash,
  readKeypair,
  validatePublicKey,
} from "./inputs.js";

export class ReceiptNotFoundError extends Error {
  constructor() {
    super("No receipt exists at that address on this network and program.");
    this.name = "ReceiptNotFoundError";
  }
}

export class ReceiptStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiptStateError";
  }
}

export interface ReceiptClientOptions {
  network?: Network;
  programId?: string | PublicKey;
  connection?: Connection;
}

export interface ReceiptTransaction {
  signature: string;
  receipt: ReceiptView;
}

interface DecodedReceipt {
  version: number;
  requestHash: number[];
  provider: PublicKey;
  client: PublicKey;
  responseHash: number[];
  createdAt: BN;
  deliveredAt: BN | null;
  acknowledgedAt: BN | null;
  status: Record<string, unknown>;
  bump: number;
}

export function networkRpcUrl(network: Network): string {
  if (network === "localnet") return "http://127.0.0.1:8899";
  if (network === "devnet") return "https://api.devnet.solana.com";
  throw new Error(
    "Network must be localnet or devnet. Mainnet is not supported.",
  );
}

export function loadReceiptIdl(): Idl {
  try {
    const idl = JSON.parse(
      readFileSync(new URL("../../idl/ack.json", import.meta.url), "utf8"),
    ) as Idl;
    if (
      !idl.address ||
      !Array.isArray(idl.instructions) ||
      !Array.isArray(idl.accounts)
    )
      throw new Error();
    return idl;
  } catch {
    throw new Error(
      "Receipt IDL is missing or invalid. Run npm run program:build, then npm run build.",
    );
  }
}

/** Bound untrusted public-RPC responses before Anchor decodes their JSON. */
const boundedRpcFetch: typeof fetch = async (input, init) => {
  const deadline = AbortSignal.timeout(12_000);
  const signal = init?.signal
    ? AbortSignal.any([init.signal, deadline])
    : deadline;
  const response = await fetch(input, { ...init, signal });
  if (!response.ok) {
    await response.body?.cancel();
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  const maximumBytes = 4 * 1024 * 1024;
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > maximumBytes)
          throw new Error(
            "RPC response exceeds the 4 MiB safety limit. Filter by client.",
          );
        chunks.push(next.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
  return new Response(Buffer.concat(chunks), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

export class ReceiptClient {
  readonly connection: Connection;
  readonly network: Network;
  readonly program: Program;
  readonly programId: PublicKey;

  constructor(options: ReceiptClientOptions = {}) {
    this.network = options.network ?? "localnet";
    const endpoint = networkRpcUrl(this.network);
    this.connection =
      options.connection ??
      new Connection(endpoint, {
        commitment: "confirmed",
        disableRetryOnRateLimit: true,
        confirmTransactionInitialTimeout: 30_000,
        fetch: boundedRpcFetch,
      });
    const idl = loadReceiptIdl();
    this.programId =
      options.programId instanceof PublicKey
        ? options.programId
        : validatePublicKey(
            options.programId ?? idl.address,
            "Program address",
          );
    this.program = new Program(
      { ...idl, address: this.programId.toBase58() },
      { connection: this.connection },
    );
  }

  deriveReceipt(
    client: PublicKey,
    requestHash: Uint8Array,
  ): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), client.toBuffer(), requireHash(requestHash)],
      this.programId,
    );
  }

  async inspect(address: PublicKey): Promise<ReceiptView> {
    const account = await this.connection.getAccountInfo(address, "confirmed");
    if (!account) throw new ReceiptNotFoundError();
    if (!account.owner.equals(this.programId) || account.executable) {
      throw new ReceiptStateError(
        "The account is not a receipt owned by this program.",
      );
    }
    const decoded = this.program.coder.accounts.decode<DecodedReceipt>(
      "receipt",
      account.data,
    );
    return this.toView(address, decoded);
  }

  async list(client?: PublicKey): Promise<ReceiptView[]> {
    // discriminator + version + request hash + provider = 8 + 1 + 32 + 32.
    const filters = client
      ? [{ memcmp: { offset: 73, bytes: client.toBase58() } }]
      : [];
    const discriminator = this.program.coder.accounts.memcmp("receipt") as {
      offset: number;
      bytes: string;
    };
    const accounts = await this.connection.getProgramAccounts(this.programId, {
      commitment: "confirmed",
      filters: [{ memcmp: discriminator }, ...filters],
    });
    return accounts
      .map(({ pubkey, account }) =>
        this.toView(
          pubkey,
          this.program.coder.accounts.decode<DecodedReceipt>(
            "receipt",
            account.data,
          ),
        ),
      )
      .sort(
        (left, right) =>
          right.createdAt - left.createdAt ||
          left.address.localeCompare(right.address),
      );
  }

  async createReceipt(
    client: Keypair,
    provider: PublicKey,
    requestHash: Uint8Array,
  ): Promise<ReceiptTransaction> {
    const hash = requireHash(requestHash);
    if (
      provider.equals(PublicKey.default) ||
      provider.equals(client.publicKey)
    ) {
      throw new ReceiptStateError(
        "Provider must be a nonzero public key different from the client.",
      );
    }
    const [receipt] = this.deriveReceipt(client.publicKey, hash);
    const existing = await this.connection.getAccountInfo(receipt, "confirmed");
    if (
      existing &&
      existing.owner.equals(this.programId) &&
      existing.data.length > 0
    ) {
      throw new ReceiptStateError(
        "This client already created a receipt for that request hash.",
      );
    }
    const instruction = await this.instruction(
      "createReceipt",
      [...hash],
      provider,
    )
      .accountsStrict({
        receipt,
        client: client.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    return this.send(instruction, client, receipt);
  }

  async markDelivered(
    provider: Keypair,
    receipt: PublicKey,
    responseHash: Uint8Array,
  ): Promise<ReceiptTransaction> {
    const hash = requireHash(responseHash);
    const current = await this.inspect(receipt);
    if (current.provider !== provider.publicKey.toBase58())
      throw new ReceiptStateError(
        "Only the nominated provider may mark delivery.",
      );
    if (current.status !== "created")
      throw new ReceiptStateError(
        "Delivery has already been marked for this receipt.",
      );
    const instruction = await this.instruction("markDelivered", [...hash])
      .accountsStrict({ receipt, provider: provider.publicKey })
      .instruction();
    return this.send(instruction, provider, receipt);
  }

  async acknowledge(
    client: Keypair,
    receipt: PublicKey,
  ): Promise<ReceiptTransaction> {
    const current = await this.inspect(receipt);
    if (current.client !== client.publicKey.toBase58())
      throw new ReceiptStateError(
        "Only the client may acknowledge this receipt.",
      );
    if (current.status !== "delivered") {
      throw new ReceiptStateError(
        current.status === "acknowledged"
          ? "This receipt is already acknowledged."
          : "The provider must mark delivery before acknowledgment.",
      );
    }
    const instruction = await this.instruction("acknowledge")
      .accountsStrict({ receipt, client: client.publicKey })
      .instruction();
    return this.send(instruction, client, receipt);
  }

  private instruction(name: string, ...args: unknown[]) {
    const build = this.program.methods[name];
    if (!build)
      throw new Error(
        `IDL is missing instruction ${name}. Rebuild the program.`,
      );
    return build(...args);
  }

  private async send(
    instruction: TransactionInstruction,
    signer: Keypair,
    receipt: PublicKey,
  ): Promise<ReceiptTransaction> {
    const signature = await sendAndConfirmTransaction(
      this.connection,
      new Transaction().add(instruction),
      [signer],
      {
        commitment: "confirmed",
        preflightCommitment: "confirmed",
        maxRetries: 3,
        abortSignal: AbortSignal.timeout(30_000),
      },
    );
    return { signature, receipt: await this.inspect(receipt) };
  }

  private toView(address: PublicKey, receipt: DecodedReceipt): ReceiptView {
    const [expected, bump] = this.deriveReceipt(
      receipt.client,
      Uint8Array.from(receipt.requestHash),
    );
    if (
      !expected.equals(address) ||
      receipt.bump !== bump ||
      receipt.version !== 1
    ) {
      throw new ReceiptStateError(
        "Receipt address, version or PDA bump is invalid.",
      );
    }
    const variants = Object.keys(receipt.status);
    const status = variants[0] as ReceiptStatus;
    if (
      variants.length !== 1 ||
      !["created", "delivered", "acknowledged"].includes(status)
    )
      throw new ReceiptStateError("Receipt status is invalid.");
    const seconds = (value: BN | null): number | null => {
      if (value === null) return null;
      const timestamp = value.toNumber();
      if (!Number.isSafeInteger(timestamp) || timestamp < 0)
        throw new ReceiptStateError(
          "Receipt timestamp is outside the supported range.",
        );
      return timestamp;
    };
    const createdAt = seconds(receipt.createdAt);
    const deliveredAt = seconds(receipt.deliveredAt);
    const acknowledgedAt = seconds(receipt.acknowledgedAt);
    if (
      createdAt === null ||
      (status === "created" &&
        (deliveredAt !== null || acknowledgedAt !== null)) ||
      (status !== "created" &&
        (deliveredAt === null || deliveredAt < createdAt)) ||
      (status === "delivered" && acknowledgedAt !== null) ||
      (status === "acknowledged" &&
        (acknowledgedAt === null ||
          deliveredAt === null ||
          acknowledgedAt < deliveredAt))
    ) {
      throw new ReceiptStateError(
        "Receipt timestamps do not match its status.",
      );
    }
    return {
      address: address.toBase58(),
      version: receipt.version,
      requestHash: requireHash(Uint8Array.from(receipt.requestHash)).toString(
        "hex",
      ),
      provider: receipt.provider.toBase58(),
      client: receipt.client.toBase58(),
      responseHash:
        status === "created"
          ? null
          : requireHash(Uint8Array.from(receipt.responseHash)).toString("hex"),
      createdAt,
      deliveredAt,
      acknowledgedAt,
      status,
    };
  }
}
