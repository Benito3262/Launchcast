// Builds public/data/v6-all-launches.json: every VibeVibe V6 launch (any age, graduated or not, any pair)
// for the owner FDV-market picker. Run: node scripts/build-launch-index.mjs
import { createPublicClient, http, parseAbi, defineChain, zeroAddress } from "viem";
import { writeFileSync } from "node:fs";
const chain = defineChain({ id: 46630, name: "Robinhood Chain Testnet", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } }, contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } } });
const c = createPublicClient({ chain, transport: http() });
const F = "0xac135da186de8325047ef2afd1d16d5971f731f7";
const fa = parseAbi(["function launchCount() view returns (uint256)", "function tokenOfLaunch(uint256) view returns (address)", "function curveOf(address) view returns (address)"]);
const ca = parseAbi(["function complete() view returns (bool)", "function pairCurrency() view returns (address)", "function pairPrincipal() view returns (uint128)", "function targetPairUnits() view returns (uint256)", "function createdAt() view returns (uint256)"]);
const ta = parseAbi(["function symbol() view returns (string)", "function name() view returns (string)"]);
const n = await c.readContract({ address: F, abi: fa, functionName: "launchCount" });
const rows = []; const pairs = new Set();
for (let start = 0n; start < n; start += 500n) {
  const ids = []; for (let i = start; i < start + 500n && i < n; i++) ids.push(i);
  const toks = (await c.multicall({ allowFailure: true, contracts: ids.map(i => ({ address: F, abi: fa, functionName: "tokenOfLaunch", args: [i] })) })).map(r => r.result);
  const curves = (await c.multicall({ allowFailure: true, contracts: toks.map(t => ({ address: F, abi: fa, functionName: "curveOf", args: [t] })) })).map(r => r.result);
  const fields = ["complete", "pairCurrency", "pairPrincipal", "targetPairUnits", "createdAt"];
  const st = await c.multicall({ allowFailure: true, contracts: curves.flatMap(cv => fields.map(f => ({ address: cv, abi: ca, functionName: f }))) });
  const meta = await c.multicall({ allowFailure: true, contracts: toks.flatMap(t => [{ address: t, abi: ta, functionName: "symbol" }, { address: t, abi: ta, functionName: "name" }]) });
  ids.forEach((id, i) => {
    const s = st.slice(i * 5, i * 5 + 5).map(r => r.result); if (s.some(x => x === undefined)) return;
    pairs.add(s[1]);
    rows.push([Number(id), toks[i], String(meta[2 * i].result ?? "").slice(0, 24), String(meta[2 * i + 1].result ?? "").slice(0, 48), s[0] ? 1 : 0, s[1], Math.round(Number(s[2] * 10000n / (s[3] || 1n))) / 100, Number(s[4])]);
  });
}
const pairSymbols = { [zeroAddress]: "ETH" };
const ps = [...pairs].filter(p => p !== zeroAddress);
const syms = await c.multicall({ allowFailure: true, contracts: ps.map(p => ({ address: p, abi: ta, functionName: "symbol" })) });
ps.forEach((p, i) => { pairSymbols[p] = syms[i].result ?? p.slice(0, 8); });
writeFileSync(new URL("../public/data/v6-all-launches.json", import.meta.url), JSON.stringify({ generatedAt: Math.floor(Date.now() / 1000), columns: ["launchId", "token", "symbol", "name", "graduated", "pair", "progressPct", "createdAt"], pairSymbols, rows: rows.reverse() }));
console.log("launches", rows.length, "graduated", rows.filter(r => r[4]).length, "pairs", pairSymbols);
