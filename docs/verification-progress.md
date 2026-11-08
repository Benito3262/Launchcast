# Launchcast verification progress

Updated: 2026-11-08

This file records reproducible research checks. These checks do not authorize market settlement.

## V6 historical supply reconstruction matrix

The scanner was run against five additional launches from `web/public/data/vibevibe-v6-tokens.json` using `npm run reconstruct:v6-supply -- <token>` on Robinhood Chain Testnet (chain ID 46630).

| Token | Launch ID | Lifecycle at registry snapshot | Pair asset | Creation block | Transfer events through observation | Mints | Burns | Reconstructed supply | Head `totalSupply()` match |
|---|---:|---|---|---:|---:|---:|---:|---:|---|
| DSDF | 1058 | Graduated | AAPL | 150353783 | 3,948 | 1 | 0 | 1,000,000,000 | Yes |
| VIBEGOLD | 1064 | Graduated | VIBEVIBEFINAL | 150363984 | 53 | 1 | 0 | 1,000,000,000 | Yes |
| VBH | 1052 | Curve | VIBEVIBEFINAL | 150344460 | 9 | 1 | 0 | 1,000,000,000 | Yes |
| SPACE | 1062 | Curve | SPCX | 150362988 | 10 | 1 | 0 | 1,000,000,000 | Yes |
| JKFD | 1085 | Curve | OPENAI | 150400645 | 22 | 1 | 0 | 1,000,000,000 | Yes |

The scanner covered factory launch history from genesis to the sampled head and token `Transfer` logs from each token's creation block through the observation head in contiguous ranges. All five runs returned `headSupplyMatches: true` and `settlementAuthority: false`.

The sample broadens the prior four-token sample to include graduated and curve-stage launches and pair assets beyond ETH. It is still a small sample. It does not prove all V6 token implementations emit standard ERC-20 `Transfer` events for every supply mutation; active V6 source code remains unverified.

## Graduated V4 historical observation probes

Two graduated launches were probed at target timestamp `1794137925`, observation block `150414578`:

| Token | Pair asset | Selected event | Event age at target | 1-hour staleness | 6-hour staleness | Historical total supply |
|---|---|---|---:|---|---|---|
| DSDF | AAPL | Swap, block 150384340 | 6,602 sec | Rejected | Accepted | Read at observation block |
| VIBEGOLD | VIBEVIBEFINAL | Swap, block 150392497 | 4,972 sec | Rejected | Accepted | Read at observation block |

Both probes validated the pool and derived the event price from the V4 `sqrtPriceX96`. The event-derived price matched the current PoolManager state at the time of the probe, but both events were older than one hour. Raising the configured maximum staleness to six hours made the diagnostic `fdvEligibility` return eligible for both samples. This demonstrates that freshness policy materially affects market eligibility; it is not a recommendation to use a six-hour limit.

The probes are diagnostic only. They do not establish adequate liquidity, prevent manipulation, establish USD value, or create a settlement attestation. The pair assets are different, so their pair-denominated FDV values are not directly comparable.

## Current implementation boundary

- V1 remains unchanged and supports graduation markets only.
- V1 has no 12-hour or 24-hour FDV market type.
- The V4 observation probe can read historical total supply for these two sampled graduated tokens, but broader support and deterministic target-time indexing remain unproven.
- No FDV market should accept stakes until a V2 resolver trust model, stale/missing observation handling, challenge/refund behavior, and contract tests are implemented.
- Do not treat the research scanner or browser/indexer output as settlement authority.

## Next verification work

1. Expand graduated V4 probes across more pair currencies and pool configurations.
2. Test exact historical observation blocks for completed 12-hour and 24-hour windows when those launches have aged enough.
3. Specify and test a resolver attestation quorum and a safe disputed/void refund path before deploying V2.
4. Add end-to-end tests for deposit, settlement, claim, fee accounting, and refund paths.
