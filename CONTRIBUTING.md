# Contributing

Start with an issue for changes that alter receipt state or authorization. Small fixes and documentation improvements can go straight to a pull request.

## Local checks

Install Node.js 22.18+, Anchor 1.2.1, Solana CLI 4.1.2 with its validator and SBF tools, and Rust. Then run:

```sh
npm install
npm run program:build
npx playwright install chromium
npm run check
npm run test:program
npm run test:e2e
```

Stop the demo before running program or browser tests; both start their own validator on port 8899. Program tests execute signed transactions against it. Keep heavy Rust builds and validator jobs sequential on smaller machines. Browser tests read actual local receipt accounts; the product demo also uses real program transactions.

Add meaningful tests for instruction or validation changes. Cover authorization and rejected transitions as well as success. Keep the CLI scriptable and the dashboard read only.

The dependency overrides keep the pinned Solana SDK on patched `jayson` and `toml` releases. Recheck the HTTP RPC client and Anchor IDL loading when changing them.

The npm package bundles the two Solana dependencies with their patched dependency tree. npm does not apply a dependency package's overrides in a consuming project. `npm run package:check` checks an isolated production install, its audit, executable and dashboard assets before publication.

Dependabot proposes compatible updates. Review major migrations manually, especially the Anchor and Solana SDK pair and the Node.js types matching the supported runtime.

## Repository hygiene

Never commit keypairs, ledgers, private response content, tokens or local environment values. Keep generated demo videos and their production scripts outside the product repository.

Use conventional commits such as `fix: reject duplicate acknowledgment`. Include the problem, the change and the checks you ran in your pull request.

Security reports should omit private keys and use a minimal local reproduction. Do not send funds to demonstrate an issue.
