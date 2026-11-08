# VibeVibe compatibility research for Launchcast

Status: the active V6 factory, curve quote path, and one graduated Uniswap V4 price path have now been independently read on Robinhood Chain Testnet. The adapter remains read-only. Do not enable prediction-market staking from these findings alone.

## Existing Launchcast support

The existing discovery service and deployed Launchcast contract continue to support the older market model. The legacy discovery service configures three earlier factory generations and expects the older `curveAt()`, `launchTimestamp()`, and `graduated()` getters.

V6 is handled by a separate adapter and output file:

- Command: `npm run discover:v6`
- Required opt-in: `ENABLE_V6_DISCOVERY=true`
- Output: `web/public/data/vibevibe-v6-tokens.json`
- Coverage: latest launch IDs from the active V6 factory only
- The V6 output is not merged into the legacy registry and is not used as settlement authority.

## Active V6 factory: on-chain verification

The current VibeVibe launch feed at [the VibeVibe V6 launches API](https://testnet.vibevibe.fun/api/v1/chains/46630/v6/launches?limit=50) identified this factory for current launches:

- Active factory: `0xac135da186de8325047ef2afd1d16d5971f731f7`

Launchcast independently checked it on Robinhood Chain Testnet (chain ID 46630):

- Factory bytecode is present.
- `launchCount()` returned 1,081 at block 150391025.
- `tokenOfLaunch()`, `isV6Token()`, `curveOf()`, and `isV6Curve()` worked for the sampled launches.
- Both `curve.token()` and `token.curve()` matched the factory mapping.
- The factory exposes `locker()`, `poolManager()`, and `hook()`; use these getters rather than copying addresses from older V6 research.
- The latest 40 launch IDs were read successfully at block 150391025: 40 validated records, 36 curve price reads, 4 graduated-pool price reads, zero linkage mismatches, zero read errors, and zero pricing errors.

The current factory's on-chain infrastructure getters returned:

- Locker: `0xcF7D6547bc11992a6c492e508E701c79B8393930`
- Uniswap V4 PoolManager: `0x8366a39CC670B4001A1121B8F6A443A643e40951`
- Hook: `0xE61e46724BA5DEC31f2be031106558774A65e8ec`

An older community reference lists factory `0xe794217880011f9cA6961340eD5c16EC9559Fea0` and locker `0x7771E60708060c43C8562c4544fBd5c365e549c0`. Those are not the active factory/locker pair for the current V6 feed checked here. The `0xe794...` factory reports a different launch count and does not recognise a token returned by the current feed. Do not substitute it for the active factory.

The ABI research lead is [Webmuiz/vibe-signals](https://github.com/Webmuiz/vibe-signals/blob/main/vibevibe.md). It is a community reference, not official protocol documentation. Launchcast has independently verified the active factory calls above against live testnet state.

## V6 ABI currently used

**Factory**

```solidity
function launchCount() view returns (uint256)
function tokenOfLaunch(uint256 launchId) view returns (address)
function curveOf(address token) view returns (address)
function isV6Token(address token) view returns (bool)
function isV6Curve(address curve) view returns (bool)
function locker() view returns (address)
function poolManager() view returns (address)
function hook() view returns (address)
```

**Token**

```solidity
function name() view returns (string)
function symbol() view returns (string)
function decimals() view returns (uint8)
function totalSupply() view returns (uint256)
function curve() view returns (address)
function transfersUnlocked() view returns (bool)
function pairCurrency() view returns (address)
```

**Curve**

```solidity
function token() view returns (address)
function pairCurrency() view returns (address)
function complete() view returns (bool)
function sold() view returns (uint120)
function targetPairUnits() view returns (uint256)
function pairPrincipal() view returns (uint128)
function createdAt() view returns (uint256)
function currentRateBps() view returns (uint256)
function quoteBuyExactIn(uint256 pairIn)
  view returns (uint256 gross, uint256 net, uint256 cost, uint256 pairFee, uint256 refund)
```

For V6, `complete()` is the curve completion flag. The current sample reads showed `complete() == true` alongside `transfersUnlocked() == true` for a graduated token. The old `graduated()` and `launchTimestamp()` getters are not assumed.

## Price and FDV calculation

The V6 adapter now produces pair-denominated price and FDV snapshots. It does not produce USD values.

### Before graduation: curve quote

For an open curve, the adapter calls `quoteBuyExactIn()` with a small input equal to 0.001 units of the pair currency, adjusted for that currency's decimals. It uses the returned `cost / net` ratio and normalizes it using the token and pair-token decimals.

This is a small buy-side quote, not a promise of execution at that price. It includes the quote function's curve mechanics and can change with input size, tax, and curve state.

### After graduation: Uniswap V4 pool state

For a completed curve, the adapter:

1. Reads the active locker from `factory.locker()`.
2. Reads `poolKeyOf(token)` from that locker.
3. Derives the PoolId from the returned PoolKey.
4. Reads the PoolManager state using `extsload()` at the V4 pool mapping slot used by this deployment.
5. Extracts the low 160 bits as `sqrtPriceX96` and normalizes the ratio using the token and pair-asset decimals.

Launchcast independently checked one graduated V6 token (`0x05a4813cd56666c80548a99f9102a0cf7d21cc73`). The derived PoolId matched the pool ID in the VibeVibe graduation record. The current `sqrtPriceX96` read from PoolManager storage also matched the most recent PoolManager `Swap` event for that PoolId. This validates the storage-read path for that sample; more graduated pools and pair types still need testing.

The V4 value is a pool spot price at the selected block. It is not an executable swap quote and does not include price impact or every possible hook/trading cost.

### FDV, supply, and denomination

The sampled V6 tokens reported 18 decimals and a total supply of 1,000,000,000 tokens (1e27 base units). The adapter reads `totalSupply()` per token rather than hardcoding that assumption.

`FDV = pair price × total supply`

The output field `fdvPairScaled1e18` is denominated in the launch's pair currency. It is **FDV**, not circulating market cap. Pair currencies can differ between launches (ETH and ERC-20 assets such as VIBEVIBE or stock-labelled test tokens), so values in different pair currencies cannot be compared directly.

The adapter does not infer USD values from a browser API, token symbol, or assumed peg. USD thresholds require a separately verified quote-asset/USD source.

## USD oracle research (not integrated)

Robinhood's official ecosystem documentation lists Chainlink as an oracle partner, but the Chainlink Data Streams verifier documentation currently lists a Robinhood Chain mainnet verifier, not a testnet verifier. Do not assume that the mainnet verifier can be used on chain ID 46630.

[ARQ Oracle's contracts page](https://arq-oracle.com/contracts) advertises a Robinhood Chain Testnet ETH/USD feed at `0x166D542EEfFe07D501E378Edb2D113f114dd5986`. The address has on-chain bytecode and responds to custom `latestRoundData()`, `getRoundData(uint256)`, and `feedId()` calls. However, standard Chainlink metadata methods such as `decimals()`, `description()`, `version()`, and `latestAnswer()` reverted in the checks performed. The Robinhood explorer API did not return a verified ABI/source for the address in this check.

This feed is therefore a research lead, not an approved settlement oracle. Before using it, verify the exact return schema and decimal scale, round ordering, update cadence, stale-data behavior, owner/governance controls, dispute process, and published audit/source. Do not hardcode 8 decimals or treat the feed as Chainlink-compatible based on its name.

## What remains before 12h/24h prediction markets

The price adapter is now a useful data source for current FDV display and research. It does not yet solve market settlement.

1. **USD conversion:** either verify a reliable source for each pair currency or explicitly limit markets to a single quote currency and denominate thresholds in that asset.
2. **Exact observation rule:** define the canonical block/time selection for the 12h and 24h observations. A late keeper must not be able to substitute a later price.
3. **Observation proof:** define how the selected block, pool/curve state, token supply, pair decimals, and calculation become verifiable to the settlement contract.
4. **More pool coverage:** test additional graduated tokens and pair currencies, including pools with different hooks or liquidity conditions.
5. **V2 contract:** the existing Launchcast contract is immutable. Any new market type needs a separate deployment and must leave existing markets untouched.

Until those are resolved, do not create or accept stakes on 12h/24h FDV markets. Current V6 prices are discovery snapshots only.

## RPC and operations

Robinhood's [official connection guide](https://docs.robinhood.com/chain/connecting/) identifies the public testnet RPC as rate-limited and recommends provider infrastructure such as Alchemy for reliable reads and archive access. The discovery service keeps `RPC_URL` configurable and uses the public endpoint by default. For sustained indexing or historical observation work, configure a dedicated provider endpoint through the environment; never put provider keys in source control or chat.

The V6 adapter is opt-in and read-only. It does not create markets, settle markets, or make transactions.
