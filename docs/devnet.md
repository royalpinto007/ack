# Deploy ack? to Devnet

Devnet is Solana's public practice network. Other people can see its accounts and transactions, but its test SOL has no monetary value. It is separate from the local validator on your computer and from Mainnet, where real SOL is used.

| Where    | What runs there                                          | Funds                         |
| -------- | -------------------------------------------------------- | ----------------------------- |
| Localnet | The validator started by `npm run demo` on your computer | Disposable local test SOL     |
| Devnet   | A shared public Solana network for development           | Free test SOL from a faucet   |
| Mainnet  | The production Solana network                            | Real SOL; unsupported by ack? |

Deploying uploads ack?'s compiled Rust program to Devnet and gives it a public program address. **It does not put the dashboard online.** The dashboard still runs on your computer and reads that address through RPC. Publishing the CLI on npm is a separate action too.

Only ack? needs a program deployment. Settled and Solana Authority Inspector read existing chain data; they do not deploy a smart contract.

## 1. Open the source project

Use a terminal in your ack checkout. Stop `npm run demo` first with Ctrl+C. You need Node.js 22.18+, Anchor 1.2.1 and Solana CLI 4.1.2 with Rust and SBF tools installed. See the [official installation guide](https://www.anchor-lang.com/docs/installation).

```sh
cd /path/to/ack
npm install
anchor --version
solana --version
```

The npm package supplies the CLI and dashboard. Use the source checkout to build and deploy the Rust program.

## 2. Prepare your Devnet identities

A **keypair file** is a private signing key. Its **public key** is the address you can share. You need a deployer that pays test SOL and controls program upgrades, and a program keypair that identifies this deployment.

Create the deployer if it does not already exist:

```sh
mkdir -p .ack target/deploy
if [ ! -f .ack/devnet-deployer-keypair.json ]; then
  solana-keygen new --no-bip39-passphrase \
    --outfile .ack/devnet-deployer-keypair.json
fi
```

The key generator prints recovery information. Keep it private. These directories are ignored by Git. Use keys dedicated to development, with no real funds.

A local build may already have generated `target/deploy/ack-keypair.json`. Reuse it only if it was generated on your machine and you control it. For a fresh checkout, create it if absent:

```sh
if [ ! -f target/deploy/ack-keypair.json ]; then
  solana-keygen new --no-bip39-passphrase \
    --outfile target/deploy/ack-keypair.json
fi
solana-keygen pubkey .ack/devnet-deployer-keypair.json
```

The last command prints your deployer's **public address**, not its private key.

## 3. Get free Devnet SOL

Paste that deployer public address into the [official Devnet faucet](https://faucet.solana.com/) and request test SOL. Check the balance:

```sh
solana balance --url devnet --keypair .ack/devnet-deployer-keypair.json
```

Test SOL pays for transactions and storage on Devnet. Faucet limits and RPC availability can vary. Deployment needs more test SOL than a receipt transaction. If the deploy command reports insufficient funds, request more test SOL or wait for the faucet limit to reset. Do not buy SOL for this walkthrough.

## 4. Build and test your program

```sh
anchor keys sync
npm run program:build
npm run check
npm run test:program
solana-keygen pubkey target/deploy/ack-keypair.json
```

`anchor keys sync` updates the public program ID in the Rust source and Anchor configuration. The build regenerates the IDL used by the CLI. These are expected public source changes; keep the private keypair out of Git. Tests still use a disposable local validator.

The last command prints your **program public address**. Keep it handy for the following steps.

## 5. Deploy to Devnet

This is the command that actually submits the program to the public practice network:

```sh
solana program deploy --url devnet \
  --keypair .ack/devnet-deployer-keypair.json \
  --program-id target/deploy/ack-keypair.json \
  target/deploy/ack.so
```

The CLI prints the program address when deployment succeeds. The deployer keeps upgrade authority, which allows it to update the program later. This walkthrough does not remove or transfer that authority, or change your global Solana configuration.

Replace `PROGRAM_PUBLIC_KEY` below with your printed program address:

```sh
solana program show PROGRAM_PUBLIC_KEY --url devnet
```

You can also paste it into [Solana Explorer on Devnet](https://explorer.solana.com/?cluster=devnet). Select Devnet when sharing an explorer link.

## 6. Open the dashboard

From the source checkout:

```sh
npm run cli -- dashboard --network devnet --program-id PROGRAM_PUBLIC_KEY
```

Or use your installed npm CLI:

```sh
npx ack-receipts dashboard --network devnet --program-id PROGRAM_PUBLIC_KEY
```

Open **http://127.0.0.1:4440**. An empty list is normal for a new deployment. This command only reads accounts; it does not create sample Devnet receipts.

## 7. Create your first public receipt

Create a separate client keypair and provider keypair if you do not have development-only keys already. Keep these files private and request faucet SOL for each public address. The client pays receipt rent and fees; the provider needs fees for its delivery transaction.

Use the [guide's signing commands](guide.md#sign-a-receipt), adding both options to every Devnet command:

```sh
--network devnet --program-id PROGRAM_PUBLIC_KEY
```

The sequence is client `create`, provider `deliver`, then client `acknowledge`. Refresh the dashboard to read the new state. Public hashes and participant addresses are visible to everyone. The program records signed claims, not proof of delivery or correctness.

[Official Solana deployment reference](https://solana.com/docs/programs/deploying) · [Public networks and RPC](https://solana.com/docs/references/clusters)
