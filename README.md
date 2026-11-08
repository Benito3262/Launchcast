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

## Planned application

The MVP will include wallet connection, eligible markets, YES/NO positions, a portfolio, settlement/claim flows, a leaderboard and guild view, plus an admin settlement dashboard.

## Development status

Documentation and research are being established before contract implementation. No contracts are deployed yet.
