# LaunchCast

**Call the curve.** LaunchCast runs free, testnet-only YES/NO prediction markets on [vibe/vibe](https://testnet.vibevibe.fun/) token launches, and every bonding curve on it is read live from Robinhood Chain Testnet.

- **Live app:** https://launchcast-zeta.vercel.app
- **Network:** Robinhood Chain Testnet (chain ID 46630). RPC `https://rpc.testnet.chain.robinhood.com`, [explorer](https://explorer.testnet.chain.robinhood.com), [faucet](https://faucet.testnet.chain.robinhood.com/)

> **Testnet only, no real value.** Stakes are tUSD from a public faucet, and gas is Robinhood testnet ETH. The contracts are unaudited.

## What it does

1. **Live bonding curves.** It reads the 60 newest launches straight from the VibeVibe V6 factory, plus each curve's raised amount, target, tokens sold, tax and graduation state. For each one it draws where the token sits on its curve, its spot price, its FDV now and at graduation, and how much is left to graduate.
2. **V2 markets.** You can take a pooled YES/NO position, in tUSD, on whether a launch **graduates by a deadline** or whether its **FDV clears a target 12 or 24 hours after launch**. Winners split the losing pool, the fee is 0%, and there's a refund if the winning side is empty or nothing is attested.
3. **Settlement from chain evidence.** The resolver signs an EIP-712 attestation of the observed block, block hash, evidence hash and outcome. Anyone can challenge it for 30 minutes, then anyone can finalize it, and winners claim. The resolver is a disclosed, single trust point (see [docs/v2-resolution-design.md](docs/v2-resolution-design.md)).

## Contracts (Robinhood Chain Testnet)

| Contract | Address |
|---|---|
| LaunchcastV2 (markets) | [`0x6c03417bb306110f4cbd560a80e0784b7d82e023`](https://explorer.testnet.chain.robinhood.com/address/0x6c03417bb306110f4cbd560a80e0784b7d82e023) |
| TestUSD (tUSD stake token, 6 decimals, public faucet) | [`0x9557aade5c89fe39941b4f3a60cbac16e3f32143`](https://explorer.testnet.chain.robinhood.com/address/0x9557aade5c89fe39941b4f3a60cbac16e3f32143) |
| Owner / deployer / resolver | [`0x54032f2d6aDc9b327F5f2222D5AE1d6346a2Cb14`](https://explorer.testnet.chain.robinhood.com/address/0x54032f2d6aDc9b327F5f2222D5AE1d6346a2Cb14) |
| VibeVibe V6 factory (read-only) | [`0xac135da186de8325047ef2afd1d16d5971f731f7`](https://explorer.testnet.chain.robinhood.com/address/0xac135da186de8325047ef2afd1d16d5971f731f7) |

V2 was deployed on 9 Nov 2026 by the [`Deploy Launchcast V2` workflow](https://github.com/Benito3262/Launchcast/actions/runs/42657812701). The retired V1 contract (`0x091413de1302640f78d41e2370507c1a8f774c45`) is still on-chain, but the app no longer uses it.

## The VibeVibe V6 curve (as measured on-chain)

Every V6 curve we checked fits a constant-product curve with virtual reserves, to within 0.001%:

```
(target/3 + raised) × (1,066,666,667 − sold) = (target/3) × 1,066,666,667
```

800M of the 1B tokens sell on the curve. When `sold` reaches 800M, `raised` equals `target` (about 4 ETH on ETH pairs) and the token graduates to a locked Uniswap v4 pool. The spot price is `V·Tv / (Tv − sold)²`, which is 16× higher at graduation than at launch. See `web/src/curve.tsx`.

## Repo layout

- `contracts/`: `LaunchcastV2.sol` (markets), `TestUSD.sol`, and the retired `Launchcast.sol` (V1)
- `test/`: Foundry tests (`forge test`)
- `services/discovery/`: VibeVibe launch indexer (runs every 6h via Actions) and the resolver/attestation tooling
- `web/`: React + Vite app, deployed on Vercel (root directory `web`)

```bash
cd web && npm install && npm run dev
```

## Roadmap

- Short live rounds (5 min / 1 h / 24 h) that anyone can open for launches meeting on-chain standards, settled purely from curve state. A tested contract proposal is on the `proposal/live-rounds` branch. It isn't deployed.
- List the LaunchCast project token as a market once it launches on vibe/vibe.

LaunchCast is an independent builder project. It isn't affiliated with or endorsed by vibe/vibe or Robinhood.
