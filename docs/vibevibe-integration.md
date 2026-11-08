# VibeVibe integration research

## Network

The community indexer configuration identifies Robinhood Chain Testnet as chain ID 46630, with RPC `https://rpc.testnet.chain.robinhood.com` and explorer `https://explorer.testnet.chain.robinhood.com`.

Recheck these values against current official sources before implementation or deployment.

## Discovery data

The community indexer repository is:

https://github.com/itstorvian/vibevibe-testnet-indexer

Its documented factory generations include:

- Retired: `0x4FEbC267e0C24440bcDEF72B5DBC5FE7BED091dF`
- Legacy: `0xB5B7A2f6c4EAFa2D73918fcA32d50e2126339eb9`
- Current: `0x40f1be6faf8DAB9C143cce1a0A04c2075Fb2DF59`

These three addresses may not represent every generation. A later snapshot reportedly included six generations, so factory discovery must be completed and independently verified before relying on a factory list. Token address is the stable token identity; launch IDs are factory-scoped and can collide across generations.

Relevant documented factory event:

`TokenLaunched(uint256 indexed launchId, address indexed token, address indexed curve, address creator, address creatorFeeRecipient, address creatorVault, uint256 initialBuy, uint256 initialTokensBought, uint16 metadataSchemaVersion, bytes32 metadataDigest, string metadataURI)`

A quoted-currency variant, `TokenLaunchedQuoted`, is also documented.

Relevant curve events include `Bought`, `Sold`, `CurveCompleted`, and `Graduated`. These are useful for indexing and historical display, but an external indexer's interpretation is not settlement authority.

## On-chain reads

The community indexer documents curve getters including:

- `token()`
- `launchTimestamp()`
- `complete()`
- `graduated()`
- `graduatedPoolId()`
- `spotPriceWad()`
- `fdvWei()`

Token getters include `name()`, `symbol()`, `decimals()`, `totalSupply()`, and `transfersUnlocked()`.

The VibeVibe core contracts are not source-verified in the explorer, and the community ABI fragments were reconstructed from frontend bundle material and selector research. Treat these ABIs as provisional. Revalidate selectors, return values, and semantics against live testnet contracts before writing resolver logic.

## RPC and indexing constraints

The public RPC is not an archive node. Research observed historical state reads failing beyond roughly 4,096 blocks. Historical activity should be reconstructed from logs, not old `eth_call` state.

The public RPC also has log-query limits, including a maximum of 10,000 matching logs and request time limits. An indexer should use adaptive block ranges, polite request pacing, retries/backoff, and reorg-aware checkpoints.

Use event logs for historical discovery and display. Do not assume old contract state remains queryable.

## Settlement safety

Smart contracts cannot inspect historical event logs. A frontend or indexer observing `Graduated` or `CurveCompleted` cannot by itself provide trustless proof to a Launchcast contract.

In particular, a market phrased as “will graduate before deadline” cannot be settled from a current `graduated()` boolean alone: current true does not prove when graduation occurred.

Only launch markets whose exact outcome can be proven from a validated on-chain predicate at resolution time. If the predicate cannot prove the market's stated condition, do not list that market type.

The meanings of `complete()` and `graduated()` are distinct and must not be conflated.

## Fees and factory generations

The documented generations have different fee policies and graduation parameters. Do not apply one generation's economics to every token. Read or validate the relevant generation-specific configuration before displaying or using fee data.

## API and terms

The VibeVibe testnet interface is https://testnet.vibevibe.fun/ and official links are listed at https://vibevibe.fun/links/.

The community indexer notes that the API is for cross-checking rather than a source of truth. Respect the service terms and rate limits; do not scrape or overload the API to construct a competing dataset.


## Expanded factory registry warning (October 8, 2026 snapshot)

A later community dashboard snapshot dated October 8, 2026 reports **six** configured factory generations, rather than the three listed in the indexer repository's current `config/factories.ts`:

| Generation | Factory address fragment | Deployment block | Launches in snapshot | Economics |
|---|---|---:|---:|---|
| Prerelease 1 | `0x701d1647…bc913a47` | 91,564,496 | 1 | Not verified |
| Prerelease 2 | `0x5b526cce…65c286f1` | 91,689,715 | 1 | Not verified |
| Prerelease 3 | `0x3e7a734b…3f311215` | 92,284,200 | 5 | Not verified |
| Retired | `0x4febc267…bed091df` | 95,916,239 | 14,816 | 100 bps; 50/50 |
| Legacy | `0xb5b7a2f6…26339eb9` | 108,435,450 | 46,456 | 125 bps; 75/25 |
| Current | `0x40f1be6f…5fb2df59` | 115,025,604 | 143,285 | 125 bps; 75/25 |

The snapshot reports 204,564 launches through block 130,996,141. The three prerelease registries add seven historical launches. It explicitly says the prerelease fee models and graduation targets are unverified.

**Important source discrepancy:** the linked indexer repository's `config/factories.ts` still declares only the original three generation types and addresses, while its separately published October 8 dashboard snapshot reports six. The dashboard abbreviates the three prerelease addresses, so these fragments are not valid deployment configuration. Do not copy them into Launchcast or assume the current indexer source has been updated to match the snapshot.

Before Launchcast discovery supports these prerelease factories, obtain their complete addresses from a reproducible source, verify deployed bytecode and creation blocks on Robinhood Chain Testnet, inspect launch-event topics and live `graduated()` behavior, and confirm each factory's curve relationship. Do not infer fee or graduation parameters from another generation.

Official Robinhood developer documentation independently confirms testnet chain ID 46630 and the public RPC/explorer endpoints: https://docs.robinhood.com/chain/add-network-to-wallet/. The public RPC is rate-limited, so it is suitable for controlled testnet verification, not an assumption of production-grade indexing.

Sources checked November 8, 2026:
- Community snapshot: https://vibevibe-testnet-dashboard.vercel.app/
- Community indexer source: https://github.com/itstorvian/vibevibe-testnet-indexer
- Official network configuration: https://docs.robinhood.com/chain/add-network-to-wallet/

## Implementation rule

The indexer is for token discovery, historical activity, and frontend presentation. Launchcast settlement must verify the relevant VibeVibe contract state directly on-chain, using independently validated interfaces and narrowly defined market predicates.
