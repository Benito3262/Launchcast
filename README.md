# LaunchCast

**Call the curve.** LaunchCast runs free, testnet-only YES/NO prediction markets on [vibe/vibe](https://testnet.vibevibe.fun/) token launches, and every bonding curve on it is read live from Robinhood Chain Testnet.

- **Live app:** https://launchcast-zeta.vercel.app
- **Network:** Robinhood Chain Testnet (chain ID 46630). RPC `https://rpc.testnet.chain.robinhood.com`, [explorer](https://explorer.testnet.chain.robinhood.com), [faucet](https://faucet.testnet.chain.robinhood.com/)

> **Testnet only, no real value.** Stakes are tUSD from a public faucet, and gas is Robinhood testnet ETH. The contracts are unaudited.

## What it does

1. **Live bonding curves.** It reads the 60 newest launches straight from the VibeVibe V6 factory, plus each curve's raised amount, target, tokens sold, tax and graduation state. For each one it draws where the token sits on its curve, its spot price, its FDV now and at graduation, and how much is left to graduate.
2. **V2 markets.** You can take a pooled YES/NO position, in tUSD, on whether a launch **graduates by a deadline** or whether its **FDV clears a target 12 or 24 hours after launch**. Winners split the losing pool, the fee is 0%, and there's a refund if the winning side is empty or nothing is attested.
3. **FDV markets on any launch.** `LaunchcastFdv` lists “Will TOKEN's FDV be above X by T?” on every VibeVibe V6 launch: any age, still on its curve or graduated, and any pair (ETH, stock tokens, VIBEVIBE, USDG and so on). It settles straight from on-chain state with no resolver (see below).
4. **V2 settlement from chain evidence.** The resolver signs an EIP-712 attestation of the observed block, block hash, evidence hash and outcome. Anyone can challenge it for 30 minutes, then anyone can finalize it, and winners claim. The resolver is a disclosed, single trust point (see [docs/v2-resolution-design.md](docs/v2-resolution-design.md)).

## Contracts (Robinhood Chain Testnet)

| Contract | Address |
|---|---|
| LaunchcastV2 (markets) | [`0x6c03417bb306110f4cbd560a80e0784b7d82e023`](https://explorer.testnet.chain.robinhood.com/address/0x6c03417bb306110f4cbd560a80e0784b7d82e023) |
| LaunchcastFdv (FDV markets, any launch, verified source) | [`0xda8051febc52f8cbf712c44a04a8d581c5d892e1`](https://explorer.testnet.chain.robinhood.com/address/0xda8051febc52f8cbf712c44a04a8d581c5d892e1) |
| LaunchcastFdvStake ($CAST-staked FDV markets, verified source) | [`0x1d2d6a4d5D685A1bE373FBd0c443b8C539BDfE14`](https://explorer.testnet.chain.robinhood.com/address/0x1d2d6a4d5D685A1bE373FBd0c443b8C539BDfE14) |
| TestUSD (tUSD stake token, 6 decimals, public faucet) | [`0x9557aade5c89fe39941b4f3a60cbac16e3f32143`](https://explorer.testnet.chain.robinhood.com/address/0x9557aade5c89fe39941b4f3a60cbac16e3f32143) |
| Owner / deployer / resolver | [`0x54032f2d6aDc9b327F5f2222D5AE1d6346a2Cb14`](https://explorer.testnet.chain.robinhood.com/address/0x54032f2d6aDc9b327F5f2222D5AE1d6346a2Cb14) |
| VibeVibe V6 factory (read-only) | [`0xac135da186de8325047ef2afd1d16d5971f731f7`](https://explorer.testnet.chain.robinhood.com/address/0xac135da186de8325047ef2afd1d16d5971f731f7) |

V2 was deployed on 9 Nov 2026 by the [`Deploy Launchcast V2` workflow](https://github.com/Benito3262/Launchcast/actions/runs/42657812701). The retired V1 contract (`0x091413de1302640f78d41e2370507c1a8f774c45`) is still on-chain, but the app no longer uses it.

`LaunchcastFdv` was deployed on 12 Nov 2026 from the owner wallet (tx [`0x81d0e0e2…`](https://explorer.testnet.chain.robinhood.com/tx/0x81d0e0e205792c467f6f66254d6c93b61fa818c1b303fd2e2fb800fcba854e03)) and sits alongside V2; V2 and its markets are untouched. Both share tUSD as the stake token with a 0% fee, and the app lists both contracts' markets together.

## Project token: $CAST

LaunchCast's project token is **$CAST** (name "Launchcast"), launched on VibeVibe V6 testnet as launch #3277 on 12 Nov 2026. The creator is the LaunchCast owner wallet, the same wallet that deploys and owns the contracts above.

| | Address / link |
|---|---|
| Token | [`0x23a1fCd0fd08a2868499C2DC695C6AcDC0B2Eeb9`](https://explorer.testnet.chain.robinhood.com/address/0x23a1fCd0fd08a2868499C2DC695C6AcDC0B2Eeb9) |
| Bonding curve | [`0x4cd8b708177ef9c712d2bfddca82e8184699ae0c`](https://explorer.testnet.chain.robinhood.com/address/0x4cd8b708177ef9c712d2bfddca82e8184699ae0c) |
| Creator wallet | [`0x54032f2d6aDc9b327F5f2222D5AE1d6346a2Cb14`](https://explorer.testnet.chain.robinhood.com/address/0x54032f2d6aDc9b327F5f2222D5AE1d6346a2Cb14) |
| Launch tx | [`0xa0720e74…`](https://explorer.testnet.chain.robinhood.com/tx/0xa0720e745e247377a18714a996391aef9c7ee8cc4b8e99eb558a03dd85634439) |
| VibeVibe page | https://testnet.vibevibe.fun/token/0x23a1fCd0fd08a2868499C2DC695C6AcDC0B2Eeb9 |

The app's **Project token** section shows the $CAST bonding curve live, and the curve is read on-chain every 20 seconds. $CAST is paired with ETH and will be added as a market later.

## $CAST markets (LaunchcastFdvStake)

`$CAST` graduated from its VibeVibe V6 bonding curve on 13 Nov 2026, which unlocks transfers, so it can now be staked. `LaunchcastFdvStake` (deployed 13 Nov 2026 from the owner wallet, tx [`0x94338fc4…`](https://explorer.testnet.chain.robinhood.com/tx/0x94338fc4d264d55fb3081d92939569af9210a757c24cb57f109ccfe41ab7e234)) runs the same FDV markets and settlement as `LaunchcastFdv`, with `$CAST` as the stake token instead of tUSD. Stakes use balance-delta accounting, so a token that taxes or rewards transfers can never leave the pools short. In the app, every card shows its stake token ("Stake $CAST" or "Stake tUSD"), and the markets list can be filtered by stake token. A fork test (`FORK_RPC=https://rpc.testnet.chain.robinhood.com forge test --match-contract LaunchcastFdvStake`) runs a full stake, observe, settle and claim cycle with real `$CAST`.

## How FDV markets settle (LaunchcastFdv)

- **FDV is read on-chain**, in the pair asset's units. On the curve it's `(target + 3·raised) × totalSupply / (3·1,066,666,667e18 − 3·sold)`, the curve's spot price times supply, and the contract refuses curves that don't fit the V6 shape. After graduation it's `totalSupply × price` from the token's locked Uniswap v4 pool (`slot0.sqrtPriceX96`, read via `PoolManager.extsload` on the pool key the V6 locker reports).
- **Betting closes** at `closeAt`, at or before the observation time `observeAt`.
- **Observation window:** for one hour after `observeAt`, **anyone** can call `observe(id)` up to three times. Calls must be at least 30 seconds and one block apart. Each call records the live FDV.
- **Settlement:** `settle(id)` is open to anyone once there are 3 observations or the window has closed. The outcome is YES if the **median** observation is at or above the threshold (the average if only two were recorded). With no observations the market is void and everyone is refunded. If nobody backed the winning side, it's also void with refunds.
- **Claim:** winners split the losing pool pro rata, with a 0% fee.
- **Trust assumptions:** there's no resolver key and no admin override. The owner can only create markets and transfer ownership. The median of three spaced reads means a manipulator has to hold the price over at least two separate blocks a minute apart, paying arbitrage each time. That's a guard, not a guarantee, so thin pools on testnet can still be pushed. Someone also has to send the observe/settle transactions; the app shows the buttons to any connected wallet during the window.

To add a market, the owner wallet opens the **Create an FDV market** form in the app (search all launches, or filter by graduated, non-ETH pair or older than 2 days). The launch index comes from `node web/scripts/build-launch-index.mjs`, and brand-new launches can be looked up by address or launch number.

## The VibeVibe V6 curve (as measured on-chain)

Every V6 curve we checked fits a constant-product curve with virtual reserves, to within 0.001%:

```
(target/3 + raised) × (1,066,666,667 − sold) = (target/3) × 1,066,666,667
```

800M of the 1B tokens sell on the curve. When `sold` reaches 800M, `raised` equals `target` (about 4 ETH on ETH pairs) and the token graduates to a locked Uniswap v4 pool. The spot price is `V·Tv / (Tv − sold)²`, which is 16× higher at graduation than at launch. See `web/src/curve.tsx`.

## Repo layout

- `contracts/`: `LaunchcastV2.sol` (markets), `LaunchcastFdv.sol` (FDV markets on any launch), `TestUSD.sol`, and the retired `Launchcast.sol` (V1)
- `test/`: Foundry tests (`forge test`; `FORK_RPC=https://rpc.testnet.chain.robinhood.com forge test --match-test testForkRealTokens` runs the FDV contract against live graduated and older tokens)
- `services/discovery/`: VibeVibe launch indexer (runs every 6h via Actions) and the resolver/attestation tooling
- `web/`: React + Vite app, deployed on Vercel (root directory `web`)

```bash
cd web && npm install && npm run dev
```

## Roadmap

- Short live rounds (5 min / 1 h / 24 h) that anyone can open for launches meeting on-chain standards, settled purely from curve state. A tested contract proposal is on the `proposal/live-rounds` branch. It isn't deployed.
- List the LaunchCast project token as a market once it launches on vibe/vibe.

LaunchCast is an independent builder project. It isn't affiliated with or endorsed by vibe/vibe or Robinhood.
