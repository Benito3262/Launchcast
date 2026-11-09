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

## V2 FDV resolver (research / testnet only)

The resolver reads the market definition from the deployed LaunchcastV2 contract. It does not accept a caller-supplied token, target FDV, observation time, or resolver version. It then:

1. Requires Robinhood Chain Testnet (46630), an open FDV12/FDV24 market, and an observation time that has arrived.
2. Finds exactly one matching active V6 factory `LaunchCreated` event, checks its canonical block hash and configured confirmation depth, and matches token/curve/pair/launch timestamp against the on-chain market.
3. Runs the historical V4 observation probe. The probe selects the last block at or before the market observation time, requires a fresh V4 price event and historical `totalSupply()` at that block, and calculates pair-denominated FDV. It does not substitute current supply.
4. Enforces the market's own `maxObservationLag`, hashes the complete evidence package, and creates the exact LaunchcastV2 EIP-712 digest. If `RESOLVER_PRIVATE_KEY` is present, it signs only when the derived address belongs to the market's snapshotted resolver set.

Run from this directory after V2 has been deployed and the environment is configured:

    npm install
    npm run resolve:fdv -- <market-id>

Required environment: `LAUNCHCAST_V2_ADDRESS`. Optional: `RPC_URL`, `CONFIRMATIONS` (default 12), `LAUNCH_EVENT_LOOKBACK_BLOCKS` (default 5000), `MAX_PRICE_STALENESS_SECONDS` (default 3600), and `RESOLVER_PRIVATE_KEY`. A resolver instance signs for one configured resolver address; two independent resolver instances must independently produce signatures for the contract's 2-of-3 quorum. Do not put private keys in source control or chat.

This is a first resolver implementation, not an oracle certification. It still relies on the V6 factory/event interpretation and historical RPC responses; it does not independently prove V4 source semantics, token supply mutation semantics, liquidity, or a USD price. The service intentionally fails closed when required history is unavailable. Do not use it for mainnet or real-value markets without independent audit, a second independent implementation, archive-RPC cross-checks, and operational key custody.

## V2 historical FDV resolver

The V2 FDV resolver and probe:v4-observation need historical contract state at the selected observation block (factory/curve metadata, pool metadata, token decimals and historical totalSupply). The default public Robinhood Chain Testnet RPC does not serve all historical state and will fail closed when an old state root is unavailable.

Configure ARCHIVE_RPC_URL to an archive-capable Robinhood Chain Testnet endpoint before running either command. ARCHIVE_RPC_URL takes precedence over RPC_URL for these two V2 resolution programs. Do not work around an archive-state error by reading current supply or current pool metadata. The resolver should not sign evidence unless every historical read is available at the exact observation block.

Provider options documented by the network/provider sources:
- **Alchemy** is the provider recommended by Robinhood's developer docs. Its Robinhood Testnet page advertises private RPC endpoints with archive data on a free account. Create a Robinhood Chain Testnet app and use `https://robinhood-testnet.g.alchemy.com/v2/<API_KEY>`.
- **SolidRPC** explicitly documents archive-backed historical state for chain ID 46630. Its endpoint format is `https://rpc.solidrpc.io/<API_KEY>/evm/46630`; it says historical requests route to archive nodes automatically.

These are candidate providers, not pre-verified Launchcast dependencies. After configuring the first endpoint, run the historical probes against the known DSDF and VIBEGOLD samples. Then configure a second, independently operated archive endpoint and compare the selected block, historical supply, V4 price, FDV, and canonical evidence hash. Do not enable resolver signing based only on a provider's archive claim or a successful latest-state request.

A successful run against one archive endpoint is still insufficient for production: independently reproduce the observation with a second archive RPC and compare the canonical evidence package before resolver signing is enabled.


## Graduation resolver

For a V2 Graduation market, run:

```bash
npm run resolve:graduation -- <on-chain-market-id>
```

The command selects the greatest canonical block timestamp less than or equal to the market's scheduled observation time, then reads the V6 factory registration, factory curve mapping, and curve `complete()` flag at that same historical block. It independently verifies the canonical `LaunchCreated` event and requires the market's configured maximum observation lag. It emits a deterministic evidence hash and EIP-712 digest; with `RESOLVER_PRIVATE_KEY`, it emits one resolver signature only if the key belongs to the market's snapshotted resolver set. One signature is not a quorum: two independent resolver signatures over the same digest are required by V2. The command does not submit an attestation transaction or settle a market.

The resolver uses `ARCHIVE_RPC_URL` first, then `RPC_URL`, then the public testnet endpoint. Historical-state access and an independent second-provider evidence cross-check remain mandatory release gates. Do not enable real-value staking based on a successful single-provider probe.


## Relaying a 2-of-3 attestation

Each independent resolver should produce its own output for the same market and canonical evidence. Both outputs must have the same `digest`, `evidenceHash`, and attestation fields, while the `signer` values must be different members of the market's snapshotted resolver set. Do not copy a signature from a different digest.

Create an `attestation-bundle.json` containing the first output's `attestation` and `evidence`, plus both outputs' signatures:

```json
{
  "action": "submit",
  "attestation": { "...": "copy the complete attestation object from a resolver output" },
  "evidence": { "...": "copy the complete evidence object from that same output" },
  "signatures": ["0x<resolver-one-signature>", "0x<resolver-two-signature>"]
}
```

Use `"challenge"` instead of `"submit"` only for a conflicting quorum during the challenge window. Keep the evidence JSON byte-for-byte structurally identical to the resolver output; the relay command recomputes its hash.

With `LAUNCHCAST_V2_ADDRESS` and a funded `RELAYER_PRIVATE_KEY` set in the local environment, run:

```bash
npm run submit:attestation -- ./attestation-bundle.json
```

The relayer independently checks chain ID, contract address, evidence hash, resolver version, canonical observation block hash and timestamp, market timing/status, FDV threshold (where applicable), the on-chain EIP-712 digest, two distinct snapshotted resolver signers, and signature ordering before broadcasting. It waits for a successful receipt. The relayer key is only a transaction sender; it is not a resolver key and cannot manufacture a quorum.

Never commit private keys, signed evidence bundles containing sensitive operational data, or environment files to the repository. The relay is not usable until V2 is deployed and two independent resolver keys are securely operated.
