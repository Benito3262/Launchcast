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

## Implementation rule

The indexer is for token discovery, historical activity, and frontend presentation. Launchcast settlement must verify the relevant VibeVibe contract state directly on-chain, using independently validated interfaces and narrowly defined market predicates.
