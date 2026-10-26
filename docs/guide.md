# Using ack?

Follow who signed each step of a delivery acknowledgment. The dashboard reads public accounts. Transactions are signed from the CLI.

## Start the local demo

You need Node.js 22.18+, Anchor 1.2.1 and Solana CLI 4.1.2 with the local validator and SBF build tools.

```sh
npm install
npm run program:build
npm run demo
```

The demo starts a local validator and creates three receipts using real program instructions: created, delivered and acknowledged. Its keys and ledger stay in ignored local files. Closing the demo stops its validator. No Devnet or Mainnet transactions run.

## Read a receipt

1. Pick a receipt from the list. Filter by status or search for an address, hash or participant.
2. Read the timeline. Every completed step names its signer and shows the chain timestamp in UTC.
3. Compare the request and response hashes. Copy public values or export the receipt as JSON.
4. Refresh to read the chain again. If the RPC becomes unavailable, the dashboard labels any previous read.

The dashboard never asks for a wallet or private key. Account data comes from the configured program on Localnet or Devnet.

## Sign a receipt

Use separate client and provider keypair files. Keep them outside version control. Both need local test SOL for transaction fees; the client also funds receipt rent.

```sh
npm run cli -- help
```

The CLI supports `hash`, `create`, `deliver`, `acknowledge`, `inspect`, `list` and `pda`. Pass the appropriate keypair path only to commands that sign. Use `--network localnet` for your local validator. See the CLI help for each command's arguments.

With your local program running, replace the public key and receipt address below with your own values:

```sh
npm run cli -- create --keypair /path/to/client.json \
  --provider PROVIDER_PUBLIC_KEY --request-id 'request-42'

# Use the receipt address returned by create.
npm run cli -- deliver --keypair /path/to/provider.json \
  --receipt RECEIPT_ADDRESS --response-file ./response.json

npm run cli -- acknowledge --keypair /path/to/client.json \
  --receipt RECEIPT_ADDRESS

npm run cli -- inspect --receipt RECEIPT_ADDRESS
```

`create` also accepts `--request-hash` instead of `--request-id`. `deliver` accepts `--response-hash` instead of `--response-file`. Hashes use 64 hexadecimal characters. `--response-file` hashes the exact file bytes; `--request-id` hashes its UTF-8 bytes.

Hash a request identifier before creating its receipt. The provider hashes the response locally and signs the delivery claim. The client inspects that claim, then signs the acknowledgment. You can supply a precomputed hash so private response content never needs to enter this tool.

## What a receipt means

| Step         | Who signs | What the record says                                            |
| ------------ | --------- | --------------------------------------------------------------- |
| Created      | Client    | This client nominated this provider for a request hash.         |
| Delivered    | Provider  | The provider claimed delivery and committed to a response hash. |
| Acknowledged | Client    | The client acknowledged that receipt.                           |

**Records signed claims, not proof of delivery or correctness.** The program cannot verify an API response, whether content reached the client, or whether the parties are honest. A timestamp records when the instruction executed on-chain.

Hashes are public commitments. Short or predictable content can be guessed and hashed for comparison. Hash private content carefully; the tool does not encrypt it or make it anonymous.

## Rules the program enforces

- Only the stored provider can claim delivery. Only the stored client can acknowledge it.
- Acknowledgment follows delivery. Each confirmation happens once.
- Participants and the request hash never change. The response hash cannot change after delivery.
- The same client and request hash identify one receipt. Different clients can use the same request hash.
- There is no delete, reset, escrow, token transfer or payment instruction.

Created receipts do not imply that the provider agreed to participate. The provider makes its first signed claim at delivery.

## Connection trouble

Run `npm run demo` for a ready local program and seeded receipts. If you run the server separately, check that the validator is running, the compiled program is deployed and the configured program ID matches it. An empty list can mean this program has no receipts on the selected network.

Devnet uses a public RPC and can be unavailable or rate limited. Refresh after a short wait. [Devnet setup](devnet.md) is optional and requires a separate deployment.
