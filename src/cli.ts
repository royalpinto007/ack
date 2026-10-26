#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Network } from "./types.js";
import {
  hashBytes,
  hashFile,
  hashHex,
  parseHash,
  readKeypair,
  validatePublicKey,
} from "./client/inputs.js";

const flags = [
  "network",
  "program-id",
  "client",
  "provider",
  "receipt",
  "keypair",
  "request-id",
  "request-hash",
  "response-file",
  "response-hash",
  "text",
  "file",
  "port",
] as const;
type Flag = (typeof flags)[number];
type Command =
  | "help"
  | "dashboard"
  | "hash"
  | "pda"
  | "create"
  | "deliver"
  | "acknowledge"
  | "inspect"
  | "list";
export interface CliArguments {
  command: Command;
  options: Partial<Record<Flag, string>>;
  network: Network;
  programId?: string;
}

const commandFlags: Record<Exclude<Command, "help">, readonly Flag[]> = {
  dashboard: ["port"],
  hash: ["text", "file"],
  pda: ["client", "request-id", "request-hash"],
  create: ["provider", "keypair", "request-id", "request-hash"],
  deliver: ["receipt", "keypair", "response-file", "response-hash"],
  acknowledge: ["receipt", "keypair"],
  inspect: ["receipt"],
  list: ["client"],
};

export const HELP = `ack?  On-chain delivery receipts

Usage: ack-receipts <command> [options]

  dashboard    [--port <port>] (read-only local dashboard)
  hash         --text <text> | --file <path>
  pda          --client <address> (--request-id <id> | --request-hash <hex>)
  create       --provider <address> --keypair <path> (--request-id <id> | --request-hash <hex>)
  deliver      --receipt <address> --keypair <path> (--response-file <path> | --response-hash <hex>)
  acknowledge  --receipt <address> --keypair <path>
  inspect      --receipt <address>
  list         [--client <address>]

Options: --network localnet|devnet (default: localnet), --program-id <address>, --help
Signing commands require an explicit keypair file. No default wallet is loaded.
Hashes are SHA-256 commitments. Timestamps are Unix seconds. Output is JSON.
The dashboard is read-only. Receipts record signed claims, not proof of service quality.
`;

export function parseCli(argv: string[]): CliArguments {
  const first = argv[0];
  if (!first || first === "help" || first === "--help" || first === "-h") {
    return { command: "help", options: {}, network: "localnet" };
  }
  if (!Object.hasOwn(commandFlags, first))
    throw new Error("Unknown command. Run with --help for usage.");
  const command = first as Exclude<Command, "help">;
  const parsed = parseArgs({
    args: argv.slice(1),
    options: {
      ...(Object.fromEntries(
        flags.map((flag) => [flag, { type: "string" }]),
      ) as Record<Flag, { type: "string" }>),
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
    tokens: true,
  });
  if (parsed.values.help)
    return { command: "help", options: {}, network: "localnet" };
  const seen = new Set<string>();
  const options: Partial<Record<Flag, string>> = {};
  for (const token of parsed.tokens) {
    if (token.kind !== "option") continue;
    if (seen.has(token.name))
      throw new Error(`Specify --${token.name} only once.`);
    seen.add(token.name);
    const flag = token.name as Flag;
    if (
      flag !== "network" &&
      flag !== "program-id" &&
      !commandFlags[command].includes(flag)
    ) {
      throw new Error(`--${flag} does not apply to ${command}.`);
    }
    const value = parsed.values[flag];
    if (typeof value !== "string") throw new Error(`--${flag} needs a value.`);
    if (value.length === 0 && flag !== "text")
      throw new Error(`--${flag} needs a nonempty value.`);
    options[flag] = value;
  }
  const network = options.network ?? "localnet";
  if (network !== "localnet" && network !== "devnet")
    throw new Error(
      "Network must be localnet or devnet. Mainnet is not supported.",
    );
  const require = (flag: Flag) => {
    if (!options[flag])
      throw new Error(`--${flag} is required for ${command}.`);
  };
  const exactlyOne = (left: Flag, right: Flag) => {
    if ((options[left] !== undefined) === (options[right] !== undefined)) {
      throw new Error(`Provide exactly one of --${left} or --${right}.`);
    }
  };
  if (["create", "deliver", "acknowledge"].includes(command))
    require("keypair");
  if (["deliver", "acknowledge", "inspect"].includes(command))
    require("receipt");
  if (command === "create") require("provider");
  if (command === "pda") require("client");
  if (command === "create" || command === "pda")
    exactlyOne("request-id", "request-hash");
  if (command === "deliver") exactlyOne("response-file", "response-hash");
  if (command === "hash") exactlyOne("text", "file");
  return {
    command,
    options,
    network,
    ...(options["program-id"] ? { programId: options["program-id"] } : {}),
  };
}

export async function runCli(argv: string[]): Promise<unknown> {
  const args = parseCli(argv);
  if (args.command === "help") return HELP;
  if (args.command === "dashboard") {
    process.env.ACK_NETWORK = args.network;
    if (args.programId !== undefined)
      process.env.ACK_PROGRAM_ID = args.programId;
    if (args.options.port !== undefined) process.env.PORT = args.options.port;
    await import("./server.js");
    return;
  }
  const option = (flag: Flag): string => {
    const value = args.options[flag];
    if (value === undefined || value === "")
      throw new Error(`--${flag} needs a nonempty value.`);
    return value;
  };
  if (args.command === "hash") {
    const hash =
      args.options.text !== undefined
        ? hashHex(args.options.text)
        : (await hashFile(option("file"))).toString("hex");
    return { algorithm: "sha256", hash };
  }
  const { ReceiptClient } = await import("./client/index.js");
  const client = new ReceiptClient({
    network: args.network,
    ...(args.programId ? { programId: args.programId } : {}),
  });
  const requestHash = () =>
    args.options["request-id"] !== undefined
      ? hashBytes(option("request-id"))
      : parseHash(option("request-hash"));
  const receiptAddress = () =>
    validatePublicKey(option("receipt"), "Receipt address");
  const context = {
    network: client.network,
    programId: client.programId.toBase58(),
  };
  switch (args.command) {
    case "pda": {
      const hash = requestHash();
      const [address, bump] = client.deriveReceipt(
        validatePublicKey(option("client"), "Client address"),
        hash,
      );
      return {
        ...context,
        address: address.toBase58(),
        bump,
        requestHash: hash.toString("hex"),
      };
    }
    case "create":
      return {
        ...context,
        ...(await client.createReceipt(
          await readKeypair(option("keypair")),
          validatePublicKey(option("provider"), "Provider address"),
          requestHash(),
        )),
      };
    case "deliver": {
      const responseHash =
        args.options["response-file"] !== undefined
          ? await hashFile(option("response-file"))
          : parseHash(option("response-hash"));
      return {
        ...context,
        ...(await client.markDelivered(
          await readKeypair(option("keypair")),
          receiptAddress(),
          responseHash,
        )),
      };
    }
    case "acknowledge":
      return {
        ...context,
        ...(await client.acknowledge(
          await readKeypair(option("keypair")),
          receiptAddress(),
        )),
      };
    case "inspect":
      return { ...context, receipt: await client.inspect(receiptAddress()) };
    case "list":
      return {
        ...context,
        receipts: await client.list(
          args.options.client
            ? validatePublicKey(args.options.client, "Client address")
            : undefined,
        ),
      };
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  runCli(process.argv.slice(2))
    .then((result) => {
      if (result === undefined) return;
      process.stdout.write(
        typeof result === "string"
          ? result
          : `${JSON.stringify(result, null, 2)}\n`,
      );
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `ack?: ${error instanceof Error ? error.message : "Command failed."}\n`,
      );
      process.exitCode = 1;
    });
}
