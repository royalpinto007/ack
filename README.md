# ack?

[![CI](https://github.com/royalpinto007/ack/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/royalpinto007/ack/actions/workflows/ci.yml)

**Two parties. One shared record.** On-chain delivery receipts for Solana.

![ack? receipt explorer showing a signed delivery acknowledgment](https://raw.githubusercontent.com/royalpinto007/ack/main/docs/screenshot.png)

A client creates a receipt. A provider signs a delivery claim with a response hash. The client signs an acknowledgment. A small Anchor program enforces that order and stores the record in a PDA.

**Records signed claims, not proof of delivery or correctness.** No response content is stored on-chain. Public hashes can still reveal guessable content.

## Run with npm

Requires Node.js 22.18+.

```sh
npx ack-receipts --help
```

The npm package includes the CLI and read-only dashboard. Use `npx ack-receipts dashboard --network devnet --program-id PROGRAM_PUBLIC_KEY` to view your own deployment. Building or deploying the Rust program requires the source checkout below.

## Run locally

Install [Node.js 22.18+](https://nodejs.org/), [Anchor 1.2.1](https://www.anchor-lang.com/docs/installation) and [Solana CLI 4.1.2](https://solana.com/docs/intro/installation), including the local validator and SBF tools.

```sh
git clone https://github.com/royalpinto007/ack.git
cd ack
npm install
npm run program:build
npm run demo
```

The demo starts a local validator, signs real transactions with disposable local keys, and serves the read-only dashboard at http://127.0.0.1:4440. It uses local test SOL for account rent. No wallet extension, database or hosted service.

## Explore

- **Program:** `create_receipt`, `mark_delivered`, `acknowledge`.
- **CLI:** create, sign and inspect receipts as JSON.
- **Dashboard:** filter receipts, follow signed transitions and copy public values.
- **Tests:** authorization, PDAs, state transitions and browser behavior.

Read the [guide](docs/guide.md), [architecture](docs/architecture.md) and [optional Devnet setup](docs/devnet.md). The dashboard includes the guide and architecture pages too.

![ack? architecture](https://raw.githubusercontent.com/royalpinto007/ack/main/docs/architecture.svg)

## Check

Stop the demo first. Program and browser tests each start their own local validator.

```sh
npm run check
npm run test:program
npm run test:e2e
```

See [contributing](CONTRIBUTING.md) for the test prerequisites. [Report a bug](https://github.com/royalpinto007/ack/issues/new?template=bug_report.yml) or [share feedback](https://github.com/royalpinto007/ack/issues/new?template=feedback.yml).

[MIT](LICENSE). [Available on npm](https://www.npmjs.com/package/ack-receipts).
