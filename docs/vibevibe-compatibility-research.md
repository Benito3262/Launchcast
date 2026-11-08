# VibeVibe compatibility research for Launchcast

Status: research findings only. Do not enable new market types or alter the existing contract from this document alone.

## What Launchcast currently supports

The discovery service currently configures three older factory generations:

- retired: `0x4FEbC267e0C24440bcDEF72B5DBC5FE7BED091dF`
- legacy: `0xB5B7A2f6c4EAFa2D73918fcA32d50e2126339eb9`
- current (V5): `0x40f1be6faf8DAB9C143cce1a0A04c2075Fb2DF59`

It scans `TokenLaunched` / `TokenLaunchedQuoted`, reads `curveAt()`, and expects the older `launchTimestamp()` / `graduated()` interface. It does not currently support V6.

## V6 research lead

An independent community project, [Webmuiz/vibe-signals](https://github.com/Webmuiz/vibe-signals), contains a VibeVibe builder reference at [vibevibe.md](https://github.com/Webmuiz/vibe-signals/blob/main/vibevibe.md). The repository was last updated 2026-10-23. Its author states the addresses and ABI below were checked against Robinhood Chain Testnet. This is useful implementation evidence, but it is not official VibeVibe documentation and Launchcast has not independently re-verified these calls in this session.

Documented V6 factory:

- Factory: `0xe794217880011f9cA6961340eD5c16EC9559Fea0`
- Zap router: `0x2784448c519D01d3aE257C0aac0b7cDAd8AccEB1`
- Graduation liquidity locker: `0x7771E60708060c43C8562c4544fBd5c365e549c0`
- Uniswap V4 PoolManager: `0x8366a39CC670B4001A1121B8F6A443A643e40951`
- V4 hook: `0xA5E27E3E54739162fe52C2C48E55B6dd6572e8EC`
- VIBEVIBE pair token: `0xF1f6b050550531226Ee0257FeC4A1E575ff4c341`

The V6 factory interface differs from the current indexer:

- `launchCount() view returns (uint256)`
- `tokenOfLaunch(uint256) view returns (address)`
- `curveOf(address token) view returns (address)`
- `isV6Token(address) view returns (bool)`
- `isV6Curve(address) view returns (bool)`
- `LaunchCreated(uint256 indexed launchId,address indexed launcher,address indexed token,address curve,string name,string symbol,string metadataURI,address pairCurrency,uint16 taxBps,uint64 packedWeights,address projectTreasury,uint256 targetPairUnits,uint256 netPersonal,uint256 giftNetTotal,bytes32 giftRoot,uint256 giftCount)`

V6 curve interface documented by that project:

- `token()`, `pairCurrency()`, `complete()`
- `sold()`, `targetPairUnits()`, `pairPrincipal()`
- `currentRateBps()`, `createdAt()`
- `quoteBuyExactIn(uint256)`
- `quoteSell(uint256)`

For V6, `complete()` is documented as the graduation flag. The liquidity migrates to Uniswap V4 in the same transaction that completes the curve. The older `graduated()` and `launchTimestamp()` getters must not be assumed to exist on V6.

The same reference documents a fixed V6 total supply of 1,000,000,000 tokens (18 decimals), with 800,000,000 allocated to curve sales and 200,000,000 to graduated liquidity. Treat this as a research claim until verified against representative token contracts on-chain.

## Price-source implications

### Before graduation

V6 curves expose `pairCurrency()`, `quoteBuyExactIn()`, `pairPrincipal()`, `targetPairUnits()`, and `sold()`. The community reference uses a small exact-input quote to estimate a curve price. That is a quote-derived execution price and may include fees/curve impact; it is not automatically equivalent to a canonical spot price. The exact valuation convention must be chosen, documented, and tested before it can settle a market.

### After graduation

The community reference says the locker exposes `poolKeyOf(token)`, which returns the V4 pool key. The pool id is derived from the key, and the V4 PoolManager exposes `extsload(bytes32)` for pool state. The reference derives `sqrtPriceX96` from the pool storage word and converts it according to currency ordering.

This is a promising on-chain price path, but it still requires independent verification of the locker, PoolManager storage layout, pool-key hashing, token ordering, decimals, and quote currency for each supported pool. Do not reuse a pool id or token ordering across launches.

### Supply and denomination

The V6 reference describes a fixed 1 billion token supply. If that is confirmed, price multiplied by total supply is an FDV-style valuation, not circulating market cap. The product must label it accurately.

V6 launches can use ETH or another ERC-20 as pair currency. A target denominated in USD therefore requires a trustworthy quote-asset/USD source. The reference lists VibeVibe server-side endpoints `/market/quote-usd-rates` and `/v6/pair-prices`, but those are API data, not an on-chain oracle. They must not silently become settlement authority.

A first version may be safer with thresholds denominated in the launch's own quote asset, provided the market clearly names that asset and the price/supply calculation is deterministic. Cross-pair comparisons and USD labels should wait for a verifiable conversion source.

## Observation and settlement

A contract cannot wake itself at 12h or 24h. A keeper submitting a late read of the current price would change the question and is not acceptable.

Before market-cap staking is enabled, define an observation window around the scheduled timestamp, a canonical block-selection rule, the exact price source and inputs, and a public record of block number, block timestamp, pool/curve state, supply and calculation. The resolver must be unable to substitute a later observation. If the chain and available infrastructure cannot prove the selected observation, keep the market disabled.

## Required verification before implementation

1. Verify V6 factory bytecode, deployment block, `launchCount()`, `tokenOfLaunch()`, `curveOf()`, `isV6Token()`, and decoded `LaunchCreated` logs on chain 46630.
2. Verify representative V6 curve bytecode and every getter used above, including return types and decimals.
3. Verify V6 launch lifecycle and migration transaction on the explorer.
4. Verify locker `poolKeyOf()`, pool-id derivation, PoolManager storage reads, and at least one known graduated token price against an independent quote.
5. Verify quote currencies and whether a usable on-chain USD oracle exists. Do not assume one.
6. Implement a separate V6 discovery adapter. Do not force V6 through the older `curveAt()` / `launchTimestamp()` / `graduated()` adapter.
7. Keep V6 discovery read-only until those checks pass. Existing markets and the deployed Launchcast contract remain untouched.

## API note

The same community reference documents a richer VibeVibe REST API under `https://testnet.vibevibe.fun/api/v1/chains/46630`, including launch details, market data, candles, wallet positions, guilds, and quote-currency USD rates. It explicitly says the API is server-side only and returns 403 from other websites' browsers. It may be useful for cached display data, but not as an unverified settlement source.
