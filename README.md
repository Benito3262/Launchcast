# Launchcast

Launchcast is a testnet-only prediction market for verifiable activity around VibeVibe token launches on Robinhood Chain Testnet.

## Project principles

- Markets must have outcomes that smart contracts can verify directly from on-chain state.
- User stakes are held in smart-contract escrow.
- YES/NO winners share the losing pool proportionally, subject to any explicitly configured fee.
- A market is resolved once; each winning participant can then claim their payout.
- Settlement is transaction-triggered. Contracts do not execute themselves at midnight or on a timer.
- The indexer and frontend help discover and display markets; neither is trusted to decide outcomes.
- Testnet assets have no monetary value. Never use a wallet seed phrase or private key in the project or chat.

## Initial network

- Network: Robinhood Chain Testnet
- Chain ID: 46630
- RPC: https://rpc.testnet.chain.robinhood.com
- Explorer: https://explorer.testnet.chain.robinhood.com
- Faucet: https://faucet.testnet.chain.robinhood.com/

Network details and contract addresses must be revalidated before deployment.

## Web application

A first React + Vite frontend is available in `web/`. It includes Robinhood Chain Testnet wallet connection, on-chain market reads, YES/NO betting with ERC-20 approval, a wallet portfolio, permissionless settlement and claims, a TestUSD faucet action, and owner-only market creation. The interface is responsive and reads market state directly from the Launchcast contract.

To run it locally:

```bash
cd web
cp .env.example .env
npm install
npm run dev
```

After the gated deployment workflow succeeds, it publishes `web/public/data/deployment.json` with the Launchcast and TestUSD addresses. The frontend loads that public config automatically; `VITE_LAUNCHCAST_ADDRESS` remains available as an optional local override.

The web build is checked by `.github/workflows/web.yml`. The frontend has not yet been deployed to a public hosting provider.

### Current testnet deployment

Launchcast and TestUSD were successfully deployed to Robinhood Chain Testnet (chain ID 46630) on 2026-11-08. The deployment workflow completed successfully on its second attempt, and the public deployment config is committed at `web/public/data/deployment.json`.

- Launchcast: `0x091413de1302640f78d41e2370507c1a8f774c45`
- TestUSD: `0x9557aade5c89fe39941b4f3a60cbac16e3f32143`
- [Launchcast contract explorer](https://explorer.testnet.chain.robinhood.com/address/0x091413de1302640f78d41e2370507c1a8f774c45)
- [TestUSD contract explorer](https://explorer.testnet.chain.robinhood.com/address/0x9557aade5c89fe39941b4f3a60cbac16e3f32143)

The app includes wallet connection, live contract market reads, YES/NO staking, portfolio and claims, TestUSD faucet access, owner-only market creation, permissionless settlement, and owner fee controls. All transactions remain testnet-only. The public website still needs a hosting connection and end-to-end wallet testing. A Vercel config is included at `web/vercel.json`. To publish it, import `Benito3262/Launchcast` in Vercel, set the project root directory to `web`, keep the build command as `npm run build` and output directory as `dist`, then deploy. The frontend reads its testnet contract addresses from the committed deployment JSON; no private key or wallet secret is needed for the frontend hosting build.

The manually gated workflow is retained for future testnet redeployments at **Actions → Deploy Launchcast to Robinhood Testnet**. It requires repository secrets `LAUNCHCAST_TESTNET_PRIVATE_KEY` (dedicated testnet-only wallet key) and `LAUNCHCAST_FEE_RECIPIENT`. Never put a private key in a commit, issue, chat message, or workflow input.

**Market wording:** the proposition is whether the curve's `graduated()` getter returns `true` when settlement is executed at or after `resolveAfter`. It does not establish whether the curve graduated before the deadline.

## VibeVibe token discovery

A read-only TypeScript event indexer is available in `services/discovery/`. It scans the three documented factory generations using `TokenLaunched` and `TokenLaunchedQuoted` logs, checks the RPC is on chain ID 46630, verifies configured factory bytecode and `launchCount()`, adapts its log-query ranges, and keeps a local resumable checkpoint. Because recent launch logs can be quiet even while factory counters have advanced historically, it also reads the latest 12 launch IDs per factory through `curveAt()`, then cross-checks `curve.token()` against `token.curve()` before displaying token details. The registry uses a 32-block confirmation buffer and labels current-state reads with the block at which they were taken.

Run it locally from `services/discovery/`:

```bash
npm install
npm run discover
```

Or, from GitHub on mobile/desktop, open **Actions → Refresh VibeVibe token registry → Run workflow**. That workflow runs the indexer and commits the refreshed static registry.

A local `npm run discover` scans a recent 100,000-block event window, then resumes from its saved cursor with a reorg overlap. The GitHub Actions workflow scans a bounded recent event window and refreshes incrementally every six hours. Every run also enumerates the latest 12 factory launch IDs per configured factory using `curveAt()`, then verifies reciprocal `curve.token()` and `token.curve()` getters. This produces 36 recent token records across the three configured factories. The registry records each factory's on-chain `launchCount()` as context; those counters are not proof that every historical event was indexed. To request it locally, run `npm run discover:full` from `services/discovery/`.

The local checkpoint is written to `services/discovery/data/checkpoint.json`; the generated registry is `web/public/data/vibevibe-tokens.json`. The frontend reads that registry for its recent-launch panel. It does not use discovery data as settlement authority.

**Coverage limitation:** the factory list is manually maintained, not a canonical on-chain registry. Three documented generations are configured; unknown factory deployments may be missing. The public RPC is rate-limited and not production-grade. Full historical indexing may require a dedicated archive/indexing provider. Token/curve getter ABIs are reconstructed community interfaces and failed reads are left unknown. Current-state reads do not prove when a historical event happened. Never use this indexer output to decide market outcomes.

## Contract implementation status

The current Solidity implementation is in the repository:

- `contracts/Launchcast.sol`: pooled YES/NO market creation, ERC-20 escrow, permissionless settlement, proportional claims, and per-recipient fee accounting.
- `contracts/TestUSD.sol`: faucet-only test token with no monetary value.
- `script/Deploy.s.sol`: Foundry deployment script with a Robinhood Chain Testnet chain-ID guard.
- `test/Launchcast.t.sol`: initial unit tests.
- `foundry.toml`: compiler and project configuration.

No contracts have been deployed. The Solidity code and tests require passing CI/local Foundry checks and an independent security review before deployment. The VibeVibe getter ABI and semantics also require live testnet verification before any real VibeVibe markets are created.

## Local contract checks

Install Foundry, then run:

```bash
forge build
forge test -vv
```

Copy `.env.example` to `.env` only on your local machine. Never commit a real private key or seed phrase. Use a dedicated testnet wallet and obtain test ETH from the official faucet for gas.

See [contract design and limitations](docs/contract-design.md) before interacting with the contracts.
