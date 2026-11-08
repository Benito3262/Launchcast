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
# Set VITE_LAUNCHCAST_ADDRESS after the Launchcast contract is deployed.
npm install
npm run dev
```

The web build is checked by `.github/workflows/web.yml`. No frontend deployment or contract deployment has been performed.

**Market wording:** the proposition is whether the curve's `graduated()` getter returns `true` when settlement is executed at or after `resolveAfter`. It does not establish whether the curve graduated before the deadline.

The next product milestones are verified VibeVibe curve discovery, token metadata display, leaderboard and guild features.

## Contract implementation status

The initial Solidity implementation is in the repository:

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
