# Launchcast market expansion

Status: approved product direction; implementation design in progress.

## Product decision

Launchcast remains focused on VibeVibe launches on Robinhood Chain Testnet. The market board expands from graduation-only predictions to three market types per eligible launch:

1. Graduation: YES/NO on whether the VibeVibe curve is graduated at the defined resolution point.
2. 12-hour market cap: YES/NO on whether the token's market cap is above a fixed target at the 12-hour observation point.
3. 24-hour market cap: YES/NO on whether the token's market cap is above a fixed target at the 24-hour observation point.

Market-cap targets are fixed when a market is created. Users choose YES or NO and stake the existing test currency. These are separate markets with separate pools and outcomes, not range buckets.

## Market-cap market requirements

Before deployment, the implementation must verify and document:

- The authoritative launch timestamp from the VibeVibe curve.
- The correct price source for each supported curve generation before graduation.
- The correct price source after graduation, including the relevant Uniswap v4 pool and token ordering.
- The supply definition used for market cap (fixed total supply versus circulating supply). The UI must name the definition rather than label an FDV figure as circulating market cap.
- The quote asset for each launch and how it is converted to a common denomination. A USD threshold requires a trustworthy, available on-chain quote-asset/USD price source; it must not rely on a browser API or an unverified spot quote.
- A deterministic observation rule for the 12-hour and 24-hour points. EVM contracts do not execute themselves at a timestamp, and a late settlement transaction must not silently substitute a later price for the intended observation.
- Snapshot block number, timestamp, price inputs, supply input, calculation and resolution transaction must be inspectable.

If an exact-time observation cannot be proven with the available on-chain data and testnet infrastructure, do not enable market-cap staking yet. Do not invent a price feed, reserve getter, pool address, or oracle.

## Trading positions

The current Launchcast contract is pooled escrow and stores user stakes as mappings; it does not issue transferable shares or support exits before resolution.

A future trading design must support partial and full exits with:
- A transparent executable exit quote.
- A minimum-out / slippage bound signed into the transaction.
- A clearly displayed fee.
- Sufficient counterparty liquidity or a defined automated market-making curve.
- Protection against withdrawals exceeding the user's available position.
- Tests for thin liquidity, one-sided pools, price impact, reentrancy and rounding.

Do not add a cosmetic Sell button until the contract can actually execute the exit.

## Competition and social layer

Add a leaderboard based on indexed, verifiable Launchcast events. Initial categories:

- Net profit after fees and realized exits.
- Prediction accuracy, with a minimum resolved-market count.
- Return on stake.
- Trading volume.

Do not rank users by raw win count alone. Publish the calculation and allow users to inspect the underlying markets and transactions.

Guilds are a later phase. Guild rankings should aggregate member performance using a disclosed formula and prevent duplicate or Sybil activity from trivially inflating scores. Competitions and rewards come after the scoring model is tested.

## Delivery sequence

1. Verify VibeVibe curve generations, price/supply semantics, quote assets, and observation mechanism.
2. Design and test a new contract version for graduation and market-cap markets. The deployed Launchcast contract is immutable and cannot gain new market types in place.
3. Add the market-type UI and token detail pages.
4. Design and test position exits before exposing selling.
5. Build event indexing and public user statistics, then leaderboard.
6. Add guilds, competitions and notifications.

All new functionality remains Robinhood Chain Testnet-only until independently tested. Existing deployed markets and the existing contract remain intact during the migration.
