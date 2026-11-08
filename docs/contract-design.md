# Launchcast contract design (initial testnet implementation)

## Components

- `Launchcast.sol` holds the market state, ERC-20 stakes, settlement result, fee accounting, and claims.
- `TestUSD.sol` is a faucet-only test token. It is not a real stablecoin and has no monetary value.
- The configured stake token must be a conventional, exact-transfer, non-rebasing ERC-20. The contract checks balance deltas on every deposit and payout and reverts if the received amount differs from the requested amount. This catches fee-on-transfer behavior, but no generic contract check can guarantee that a token will never rebase or later change its behavior; the token implementation must be reviewed and trusted.
- `Deploy.s.sol` deploys a fresh TestUSD and Launchcast instance using the deployer's testnet wallet.

## Market lifecycle

1. The owner creates a market for a VibeVibe curve address and a future `resolveAfter` timestamp.
2. Creation performs a read-only call to `graduated()` to check that the target exposes the expected boolean getter.
3. Users approve TestUSD and stake on YES or NO before `resolveAfter`.
4. At or after `resolveAfter`, any wallet may submit `settleMarket`. The contract reads `graduated()` directly from the configured curve and records that boolean as the outcome.
5. Users call `claim` individually after resolution.

The chain does not execute a transaction automatically at the deadline. The market remains unsettled until a wallet submits a settlement transaction. The admin dashboard can batch-settle up to 25 markets, while any user can settle an individual eligible market.

## Payouts

- The winning side receives its original stake plus a proportional share of the losing pool, after the configured fee.
- The fee is deducted from the losing pool only when both sides have stakes.
- If nobody backed the winning outcome, all participants can reclaim their own stakes.
- If the winning side has no opposing pool, winning participants receive their original stakes.
- Fee amount and fee recipient are snapshotted when a market settles, so later global fee changes or recipient rotation do not rewrite that market's payout or redirect its accrued fee.
- Accrued fees are tracked per snapshotted recipient. Each recipient can withdraw only the balance assigned to their own address; changing the current fee recipient does not transfer ownership of previously accrued fees.
- Integer division can leave a small rounding remainder in the contract. There is intentionally no owner sweep or dust withdrawal in this version, so the remainder cannot be accidentally or administratively taken from the pool. A later audited version may add a dust-recovery policy only after all claim liabilities are provably extinguished.

## Trust and control assumptions

- Market creation is owner-only. The owner chooses the curve address and settlement timestamp; this is a meaningful trust assumption.
- Settlement itself is permissionless and reads the VibeVibe contract directly.
- The fee rate and future fee recipient are owner-controlled. The initial deployment sets the fee to 0 bps; fee policy must be disclosed before any non-zero fee is enabled. A recipient can withdraw only fees already allocated to its own address.
- The current implementation has no user cancellation or early refund path.
- This implementation does not include a market question/title field on-chain. The frontend must show a precise, human-readable description tied to the curve address and the exact settlement predicate.

## Critical VibeVibe limitation

This market resolves the current `graduated()` state when settlement is executed at or after `resolveAfter`. It cannot prove the historical timestamp at which graduation occurred.

Therefore, do not describe this as “will graduate before [deadline]”. It means “is graduated when this market is settled after [settlement time]”. A deadline-based historical predicate needs a separate cryptographic proof mechanism or a suitable VibeVibe contract getter that exposes and guarantees the relevant timestamp.

The live VibeVibe ABI, deployed curve implementation, and exact meaning of `graduated()` must be independently checked on Robinhood Chain Testnet before deploying Launchcast or creating real markets.

## Pre-deployment checklist

- [ ] Run `forge build` and `forge test -vv` locally.
- [ ] Review Solidity with an independent security reviewer.
- [ ] Verify VibeVibe curve getter ABI and semantics against live testnet contracts.
- [ ] Verify factory-generation coverage and curve address provenance.
- [ ] Test fee, rounding, empty-side refund, and multiple-user payout cases.
- [ ] Test with a dedicated wallet and test tokens only.
- [ ] Confirm deployment chain ID is 46630 before broadcasting (the deployment script now enforces this).
- [ ] Verify deployed bytecode and addresses in the Robinhood testnet explorer.
