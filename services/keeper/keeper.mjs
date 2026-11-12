// LaunchCast V2 keeper: opens rounds for VibeVibe launches that meet the on-chain standards,
// proves YES touches and resolves ended rounds. Every action it takes is also open to anyone
// (the contract is permissionless); this only keeps the board fresh. Testnet only.
import { createPublicClient, createWalletClient, defineChain, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.RPC_URL || "https://rpc.testnet.chain.robinhood.com";
const ROUNDS = process.env.ROUNDS_ADDRESS;
const FACTORY = "0xac135da186de8325047ef2afd1d16d5971f731f7";
const MAX = { 0: Number(process.env.MAX_SPRINTS ?? 2), 1: Number(process.env.MAX_CLIMBS ?? 1), 2: Number(process.env.MAX_GRADUATIONS ?? 1) };
const SCAN_LAUNCHES = Number(process.env.SCAN_LAUNCHES ?? 120);
const DRY = process.env.DRY_RUN === "1";

const chain = defineChain({ id: 46630, name: "Robinhood Chain Testnet", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const roundsAbi = parseAbi([
  "function roundCount() view returns (uint256)",
  "function getRound(uint256) view returns ((address token,address curve,address creator,uint8 tier,uint8 status,uint64 startAt,uint64 lockAt,uint64 endAt,uint128 startPrincipal,uint128 strike,uint256 target,uint128 yesPool,uint128 noPool))",
  "function isTouched(uint256) view returns (bool)",
  "function latestRound(address,uint8) view returns (uint256)",
  "function eligibility(address,uint8) view returns (uint8 reason,address curve,uint128 principal,uint128 strike,uint256 target)",
  "function createRound(address,uint8) returns (uint256)",
  "function proveTouch(uint256)",
  "function resolve(uint256)",
]);
const factoryAbi = parseAbi(["function launchCount() view returns (uint256)", "function tokenOfLaunch(uint256) view returns (address)"]);

if (!ROUNDS) throw new Error("ROUNDS_ADDRESS is required");
const key = process.env.PRIVATE_KEY;
if (!key && !DRY) throw new Error("PRIVATE_KEY is required unless DRY_RUN=1");
const account = key ? privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`) : null;
const wallet = account ? createWalletClient({ account, chain, transport: http(RPC) }) : null;
if ((await pub.getChainId()) !== 46630) throw new Error("Wrong chain");

async function send(fn, args, label) {
  if (DRY || !wallet) { console.log("[dry]", label); return; }
  try {
    await pub.simulateContract({ address: ROUNDS, abi: roundsAbi, functionName: fn, args, account });
    const hash = await wallet.writeContract({ address: ROUNDS, abi: roundsAbi, functionName: fn, args });
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
    console.log(r.status, label, hash);
  } catch (e) { console.log("skip", label, (e.shortMessage || e.message).split("\n")[0]); }
}

const now = BigInt(Math.floor(Date.now() / 1000));
// 1) settle rounds that people actually bet on
const count = await pub.readContract({ address: ROUNDS, abi: roundsAbi, functionName: "roundCount" });
const ids = []; for (let i = count; i > 0n && i > count - 150n; i--) ids.push(i);
const rounds = ids.length ? await pub.multicall({ allowFailure: false, contracts: ids.map(id => ({ address: ROUNDS, abi: roundsAbi, functionName: "getRound", args: [id] })) }) : [];
for (let k = 0; k < ids.length; k++) {
  const r = rounds[k], id = ids[k];
  if (r.status !== 0 || (r.yesPool === 0n && r.noPool === 0n)) continue;
  if (now > r.endAt) await send("resolve", [id], `resolve #${id}`);
  else if (await pub.readContract({ address: ROUNDS, abi: roundsAbi, functionName: "isTouched", args: [id] })) await send("proveTouch", [id], `proveTouch #${id}`);
}

// 2) open fresh rounds on the most advanced eligible launches
const n = await pub.readContract({ address: FACTORY, abi: factoryAbi, functionName: "launchCount" });
const launchIds = []; for (let i = n - 1n; i >= 0n && i >= n - BigInt(SCAN_LAUNCHES); i--) launchIds.push(i);
const tokens = await pub.multicall({ allowFailure: true, contracts: launchIds.map(i => ({ address: FACTORY, abi: factoryAbi, functionName: "tokenOfLaunch", args: [i] })) });
const list = [...new Set(tokens.filter(t => t.status === "success").map(t => t.result))];
for (const tier of [0, 1, 2]) {
  if (!MAX[tier]) continue;
  const el = await pub.multicall({ allowFailure: true, contracts: list.map(t => ({ address: ROUNDS, abi: roundsAbi, functionName: "eligibility", args: [t, tier] })) });
  const latest = await pub.multicall({ allowFailure: true, contracts: list.map(t => ({ address: ROUNDS, abi: roundsAbi, functionName: "latestRound", args: [t, tier] })) });
  const open = rounds.filter(r => r.tier === tier && r.endAt > now).length;
  const busy = new Set(rounds.filter(r => r.tier === tier && r.endAt > now).map(r => r.token.toLowerCase()));
  const candidates = list.map((t, i) => ({ t, e: el[i].result, l: latest[i].result }))
    .filter(c => c.e && c.e[0] === 0 && !busy.has(c.t.toLowerCase()))
    .sort((a, b) => Number(b.e[2] * 10000n / b.e[4]) - Number(a.e[2] * 10000n / a.e[4]));
  for (const c of candidates.slice(0, Math.max(0, MAX[tier] - open))) await send("createRound", [c.t, tier], `create tier ${tier} ${c.t}`);
  console.log(`tier ${tier}: ${candidates.length} eligible, ${open} open`);
}
