# Launchcast V2 pre-deployment security review

Status: internal engineering review only. This is not an independent audit, formal verification, or deployment approval.

## Automated checks

- Foundry: 54 Solidity tests pass (33 V1 regression tests and 21 V2 tests).
- Discovery service: TypeScript typecheck passes and 25 unit tests pass.
- Web app: TypeScript check and production Vite build pass with V2 market filters, estimated payouts, claim gating, and wallet portfolio history.
- `forge fmt --check contracts/LaunchcastV2.sol test/LaunchcastV2.t.sol` and `git diff --check` pass. The repository-wide formatter check still reports pre-existing formatting differences in the V1 contract.
- Slither: analyzed `contracts/LaunchcastV2.sol` with 102 detectors.
- Formatting and `git diff --check` pass.

## Slither findings and disposition

### High: `reentrancy-balance` (four reports)

Slither reports pre/post token balance snapshots around the low-level ERC-20 calls in `_safeTransfer` and `_safeTransferFrom`. These helpers intentionally compare exact sender and recipient balance deltas to reject fee-on-transfer or otherwise non-exact stake tokens.

Reachable call paths are guarded:

- `_safeTransferFrom` is called only by `placeBet`, which is `nonReentrant`.
- `_safeTransfer` is called only by `claim` and `withdrawFees`, both `nonReentrant`.
- All other state-changing external entry points are also `nonReentrant`, so a malicious stake token cannot re-enter another state mutation during a token callback.
- `testStakeTokenCannotReenterAnyMarketMutationDuringTransfer` uses a callback-capable malicious token and confirms the nested `placeBet` call is rejected while the intended stake is recorded once.

The static detector does not prove the guard's complete call-graph coverage. This finding must be re-reviewed independently before any real-value deployment; it is not silently waived.

### Low: timestamp comparisons

Market opening/closing, observation, challenge, finalization, and timeout rules depend on `block.timestamp`. Small validator timestamp deviations are an inherent chain-level consideration. The markets use 12-hour/24-hour observation horizons and a 30-minute challenge period; production risk parameters still require chain-specific review.

### Informational: assembly and low-level calls

- `_recover` uses assembly to read the fixed 65-byte ECDSA signature layout; the surrounding function validates signature length, `v`, nonzero signer, and low-`s`.
- Low-level ERC-20 calls are followed by return-data checks and exact balance-delta checks. Only a contract stake token is accepted.

## Remaining trust and oracle limitations

- One market-snapshotted owner/resolver wallet attests to the evidence; the contract does not independently prove historical V4 state or token supply.
- The active V6 factory/event and V4 pool semantics have not been independently verified against full deployed source code.
- Initial resolver signing and submission now rerun the same deterministic historical resolver against a second, different archive-provider host and require the same evidence hash and EIP-712 digest. This provides archive-provider diversity, not an independent resolver implementation. Challenge evidence replay is not yet implemented, and `SECONDARY_ARCHIVE_RPC_URL` must be configured with a validated second provider.
- Historical `totalSupply()` support is provider-dependent; the resolver fails closed when unavailable.
- Pair-denominated FDV is not USD FDV and does not imply liquidity or executable exit value.
- The single owner/resolver key is a concentrated trust and custody risk; operational monitoring and incident response procedures are not yet production-ready.

## Claim and portfolio behaviour

- A resolved losing position now reverts with `NothingToClaim`; it cannot be marked as claimed with a zero payout. Winning positions can claim, while voided markets allow both sides to reclaim their stakes.
- The V2 interface only renders a claim action for a winning position or a voided-market refund. Portfolio history derives win/loss/refund state, payout, and net result from the on-chain market and position values.

## Release gate

Do not deploy for real-value use until an independent Solidity review, a second independent evidence implementation, archive-RPC evidence cross-checks, owner-key custody review, and full testnet lifecycle testing have passed. Testnet deployment should remain explicitly gated and separate from V1.

## Single-wallet settlement authority

The V2 constructor configures the existing deployer/owner wallet as the sole resolver. Each market snapshots that address, and one EIP-712 signature from it authorises settlement. This matches the original Launchcast operating model and removes the unnecessary three-wallet setup. The trade-off is explicit: the owner wallet is a concentrated trust and key-custody risk. A compromised or misused key can sign an incorrect outcome, so archive evidence checks, monitoring, and independent security review remain release requirements.
