# Launchcast V2 resolution design

Status: first testnet contract implementation and test suite are in progress. V1 is immutable and remains untouched. The contract is not audited and is not deployed.

## 1. Market types

V2 creates three independent YES/NO markets for each eligible VibeVibe launch:

- Graduation: whether the token has graduated by the launch-relative observation time.
- 12-hour FDV: whether fully diluted valuation is at or above a fixed pair-denominated target at launch time + 12 hours.
- 24-hour FDV: the same proposition at launch time + 24 hours.

Each market has its own YES and NO pool, close time, target, result, fees and claims. Thresholds are fixed at creation. A user cannot change a market's target after anyone has staked.

The FDV UI must say **FDV in [pair asset]**, not circulating market cap and not USD unless a separately verified quote-asset/USD feed is integrated. Initial V2 FDV support is limited to graduated V6 tokens with a validated V4 pool. Curve-stage FDV remains disabled until historical curve pricing can be reproduced at the exact target block.

## 2. Deterministic observation

For a target timestamp, the resolver must select the canonical block with the greatest timestamp less than or equal to the target. It must not use a later block or the price at the time a settlement transaction happens.

The evidence package contains:

- chain ID, market ID, token, curve, pair currency and pool ID;
- target timestamp, observation block number, block timestamp and block hash;
- selected V4 Initialize/Swap event type, block, transaction hash, log index and block hash;
- event age at the target and configured maximum staleness;
- normalized pair-per-token price, token decimals and historical total supply;
- computed pair-denominated FDV and the fixed market threshold;
- resolver implementation/version and a content hash of the complete evidence package.

The selected price event must be at or before the observation block. If the pool is uninitialized, stale, malformed, or missing, the market is voided and stakes are refundable. The resolver must never substitute a later price. Historical total supply must be read at the observation block or reconstructed only under a separately approved and verified supply model.

For an observation block, the resolver should require a small maximum block-timestamp lag behind the target. The initial testnet policy should be configurable per market and start conservatively (for example, 60 seconds); this must be validated against actual Robinhood Chain block cadence before production.

## 3. Attestation and dispute policy

V2 uses the existing Launchcast owner/deployer wallet as the single authorised resolver. No additional resolver wallets or committee are required.

- The contract sets the initial resolver to the deployer wallet at construction. Each market snapshots that resolver address and resolver version when created.
- One valid EIP-712 signature from that wallet authorises settlement. The signed payload binds chain ID, V2 contract address, market ID, outcome, observation block/hash/time, evidence hash, FDV inputs, and resolver version.
- The same owner wallet may rotate the resolver for future markets; existing markets retain their snapshotted resolver.
- A valid initial attestation opens a 30-minute challenge window. A conflicting second attestation from the same authorised wallet marks the market disputed and refundable; this is an administrative correction/fail-safe, not an independent challenge mechanism.
- If no valid attestation is submitted within 24 hours after the target, anyone can void the market and return stakes.
- If the evidence fails validation or violates the market's freshness/observation rules, the market is voided rather than assigned a guessed outcome.
- After the challenge window closes without a conflict, anyone can finalize the attested result.
- The owner cannot prevent a participant from claiming a refund from a void market.

This is a single-operator trust model, matching the existing settlement workflow. It is not trustless price verification: compromise or misuse of the owner/resolver wallet can produce a false result. Evidence validation and independent archive-provider cross-checks remain important safeguards.

## 4. Escrow and positions

- V1's exact-transfer ERC-20 checks, pooled YES/NO accounting, fee cap and reentrancy protection are retained.
- A resolved market pays winning participants proportionally from the losing pool after the disclosed fee.
- Graduation markets stop accepting new bets as soon as the V6 curve reports `complete()`, even if the scheduled close time is later. This is a conservative early-close guard; the resolver still determines the final graduation result from canonical V4 pool evidence at the observation time.
- If a resolved market has no winning-side pool, every participant can reclaim their own YES and NO stakes. No fee is charged in this case.
- A void/disputed market refunds each participant's YES and NO stakes.
- Claims are permissionless per user but only the position owner can receive the payout.
- No Sell action is exposed until a real exit mechanism exists. A cosmetic sell button is prohibited. A future sell feature needs transferable position shares or an explicitly tested early-exit accounting model.

## 5. Leaderboard data

Leaderboard data is derived from V2 contract events and claim outcomes, not client-submitted numbers. Initial rankings should expose separate metrics:

- realized net profit after fees and claims;
- return on stake;
- accuracy, shown only after a minimum resolved-market count;
- volume as a separate activity metric.

Unclaimed winnings are not realized profit. Open positions are not counted as realized P&L. Raw win count is not a ranking metric by itself. Guilds and competitions come after the event indexer and user-level accounting are validated.

## 6. Release gates

V2 must not be deployed with live staking until all of these pass:

1. Foundry tests for market creation, immutable targets, close times, single-owner signature validation, wrong-wallet signatures, wrong-chain signatures, replay protection, stale evidence, invalid block data, challenge conflicts, void refunds, fees, claims, and reentrancy.
2. Integration tests for all three market types and each pair-asset decimal configuration.
3. Historical observation tests across multiple graduated tokens, pair currencies and pool configurations.
4. A successful full testnet flow: create market, stake YES and NO, submit attestation, challenge or finalize, settle, claim/refund, and reconcile contract balances.
5. Frontend labels and evidence links that show the exact proposition, pair denomination, target time, authorised resolver wallet, status and refund conditions.

No V2 contract deployment, market staking, or production settlement is authorized by this design document alone.


## 7. First contract implementation

`contracts/LaunchcastV2.sol` implements the three market types, fixed launch-relative 12h/24h observation timestamps, YES/NO pooled staking, exact-transfer ERC-20 checks, per-market fee snapshots, EIP-712 attestations, a snapshotted single owner-wallet resolver, a 30-minute challenge window, conflict-to-void behavior, 24-hour attestation timeout, permissionless finalization, and participant refunds for void markets.

`test/LaunchcastV2.t.sol` covers market timing, FDV threshold consistency, single-owner signatures and resolver rotation, replay protection, conflicting attestations, timeout refunds, empty winning pools, proportional payouts and fees. The deployment script is separate from V1 and requires only the existing stake token and fee-recipient configuration; the deployer wallet is automatically the resolver.

This is an initial implementation, not a security audit. The contract cannot independently prove the resolver's historical block, V4 event, pool liquidity, launch event, or historical supply claims; it relies on the signed resolver evidence hash. Before deployment, the resolver service must build and independently cross-check the full evidence package, and the deployment parameters and resolver key custody must be reviewed.
