# Optional Devnet setup

Start with the local demo and tests. Devnet is a separate, optional deployment. It uses free test SOL for fees and rent and a public RPC that may be rate limited. Mainnet is unsupported.

## Prepare your own keys

Stop the local demo. Create a deployer keypair and a program keypair that you control:

```sh
mkdir -p .ack target/deploy
solana-keygen new --no-bip39-passphrase \
  --outfile .ack/devnet-deployer-keypair.json
solana-keygen new --no-bip39-passphrase \
  --outfile target/deploy/ack-keypair.json
```

If either file already exists, do not overwrite it. A local build may already have generated the program keypair. Reuse it only if it was generated on your machine and you control it, or securely move it aside before generating a separate program identity.

Both directories are ignored by Git. Keep these keys private. Never use a wallet funded on Mainnet. Request test SOL for the deployer's public address from the [Solana Devnet faucet](https://faucet.solana.com/).

## Build for that program identity

```sh
anchor keys sync
npm run program:build
solana-keygen pubkey target/deploy/ack-keypair.json
```

`anchor keys sync` changes the program ID in the Rust source and Anchor configuration. The build refreshes the IDL used by the TypeScript client. Keep those public IDs consistent. Changing them also changes the local program identity.

Run the local program tests again before deployment:

```sh
npm run check
npm run test:program
```

## Deploy when ready

This command submits a Devnet deployment using your test SOL:

```sh
solana program deploy --url devnet \
  --keypair .ack/devnet-deployer-keypair.json \
  --program-id target/deploy/ack-keypair.json \
  target/deploy/ack.so
```

Deployment does not transfer upgrade authority. The program keypair identifies the program; the deployer controls its upgrade authority unless you explicitly change it. This guide does not change your global Solana configuration.

## Read and sign

Replace `PROGRAM_PUBLIC_KEY` with the public key printed earlier. Build and start the read-only dashboard:

```sh
npm run build
ACK_NETWORK=devnet ACK_PROGRAM_ID=PROGRAM_PUBLIC_KEY npm start
```

Use `--network devnet --program-id PROGRAM_PUBLIC_KEY` with CLI commands. Signing still requires your explicit `--keypair` path. The client and provider need their own Devnet test SOL for fees; the client also pays receipt rent.

`npm run demo` always starts the local demo. It does not deploy to Devnet. Never share keypair files, private responses or seed phrases in issues or exported examples.
