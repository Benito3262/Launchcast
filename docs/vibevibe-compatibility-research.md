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
- `tokenOfLaunch()`, `isV6Token()`, `curveOf()`, and `isV6Curve()` worked for the sampled launches.¶»§q«^