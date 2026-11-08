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
    npm run discover

The workflow uses a bounded recent event-log window on the first run, then resumes from a local checkpoint with a 63-block overlap. It also enumerates the latest 12 factory launch IDs per generation using `curveAt()` and cross-checks each curve/token pair. This is designed for the public RPC's response-size and rate limits; it is not a full historical event archive. A full-history scan remains available for controlled environments with a suitable RPC provider:

    npm run discover:full

The local checkpoint is written to `data/checkpoint.json` (gitignored). The generated frontend registry is written to `../../web/public/data/vibevibe-tokens.json`. Only the latest 12 token launches per configured factory are enriched with best-effort current-state getters. These reads are snapshots at the latest safe block, not historical data.

A one-click GitHub workflow is available under **Actions → Refresh VibeVibe token registry → Run workflow**. It runs the indexer and commits the static registry to the repository.

Keep RPC provider secrets in local environment variables; never commit them. The public Robinhood RPC is rate-limited and enforces response-size limits. Full-history indexing should use a dedicated archive/indexing provider and smaller adaptive ranges.
