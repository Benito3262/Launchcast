# Launchcast VibeVibe discovery

Read-only launch discovery for Robinhood Chain Testnet (46630). It reads factory launch events and writes a local JSON snapshot. It does not create markets, decide outcomes, or trust the VibeVibe API.

## Current limits and safety

- The three factory addresses are sourced from the community-maintained [VibeVibe testnet indexer](https://github.com/itstorvian/vibevibe-testnet-indexer). That repository records them as verified on-chain on 2026-09-13. Revalidate bytecode and factory getters against the live RPC before relying on them.
- Core VibeVibe contracts are not source-verified. Event signatures were reconstructed from the public frontend bundle and live logs by that project. Keep this scanner read-only until a live RPC run confirms decoding.
- Factory coverage can never be assumed complete: new factory generations may appear. Check for new deployments and unknown curve activity periodically.
- Launch IDs are factory-scoped. Records are deduplicated by transaction hash and log index; token address is the stable project identity.
- The public RPC is not an archive node. Historical logs may be available even when historical contract storage is not.
- Only a curve current graduated() state can be used for settlement. This does not prove when graduation occurred.

## Run

From this directory:

    npm install
    cp .env.example .env
    npm run discover

The output is data/launches.json and is intentionally gitignored. Keep RPC provider secrets in local environment variables; never commit them.
