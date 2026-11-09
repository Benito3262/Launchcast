import { useCallback, useEffect, useMemo, useState } from "react";
import "./v2.css";
import {
  createPublicClient, defineChain, formatUnits, http, parseAbiItem, parseUnits,
  type Address, type Hex, type WalletClient,
} from "viem";

const chain = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Robinhood Testnet ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [import.meta.env.VITE_ROBINHOOD_TESTNET_RPC || "https://rpc.testnet.chain.robinhood.com"] } },
  testnet: true,
});
const rpc = import.meta.env.VITE_ROBINHOOD_TESTNET_RPC || "https://rpc.testnet.chain.robinhood.com";
const publicClient = createPublicClient({ chain, transport: http(rpc) });
const erc20Abi = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;
const abi = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "stakeToken", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "marketCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "feeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "getMarket", stateMutability: "view", inputs: [{ name: "marketId", type: "uint256" }], outputs: [{ name: "market", type: "tuple", components: [
    { name: "marketType", type: "uint8" }, { name: "status", type: "uint8" },
    { name: "token", type: "address" }, { name: "curve", type: "address" },
    { name: "pairCurrency", type: "address" }, { name: "launchAt", type: "uint64" },
    { name: "observationAt", type: "uint64" }, { name: "closeAt", type: "uint64" },
    { name: "maxObservationLag", type: "uint64" }, { name: "observationBlock", type: "uint64" },
    { name: "observationTimestamp", type: "uint64" }, { name: "challengeEndsAt", type: "uint64" },
    { name: "observationBlockHash", type: "bytes32" }, { name: "evidenceHash", type: "bytes32" },
    { name: "challengeEvidenceHash", type: "bytes32" }, { name: "targetFdv", type: "uint256" },
    { name: "attestedFdv", type: "uint256" }, { name: "yesPool", type: "uint128" },
    { name: "noPool", type: "uint128" }, { name: "outcomeYes", type: "bool" },
    { name: "feeBps", type: "uint16" }, { name: "feeRecipient", type: "address" },
    { name: "resolverVersion", type: "uint32" }, { name: "resolvers", type: "address[3]" },
  ] }] },
  { type: "function", name: "yesStake", stateMutability: "view", inputs: [{ name: "", type: "uint256" }, { name: "", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "noStake", stateMutability: "view", inputs: [{ name: "", type: "uint256" }, { name: "", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "hasClaimed", stateMutability: "view", inputs: [{ name: "", type: "uint256" }, { name: "", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "placeBet", stateMutability: "nonpayable", inputs: [{ name: "marketId", type: "uint256" }, { name: "sideYes", type: "bool" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{ name: "marketId", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "finalizeMarket", stateMutability: "nonpayable", inputs: [{ name: "marketId", type: "uint256" }], outputs: [] },
  { type: "function", name: "voidDisputedMarket", stateMutability: "nonpayable", inputs: [{ name: "marketId", type: "uint256" }], outputs: [] },
  { type: "function", name: "voidUnattestedMarket", stateMutability: "nonpayable", inputs: [{ name: "marketId", type: "uint256" }], outputs: [] },
  { type: "function", name: "createMarket", stateMutability: "nonpayable", inputs: [
    { name: "marketType", type: "uint8" }, { name: "token", type: "address" },
    { name: "curve", type: "address" }, { name: "pairCurrency", type: "address" },
    { name: "launchAt", type: "uint64" }, { name: "observationAt", type: "uint64" },
    { name: "closeAt", type: "uint64" }, { name: "maxObservationLag", type: "uint64" },
    { name: "targetFdv", type: "uint256" },
  ], outputs: [{ name: "marketId", type: "uint256" }] },
] as const;

type V2Market = {
  id: bigint; marketType: number; status: number; token: Address; curve: Address;
  pairCurrency: Address; launchAt: bigint; observationAt: bigint; closeAt: bigint;
  maxObservationLag: bigint; challengeEndsAt: bigint; observationBlock: bigint; observationTimestamp: bigint;
  observationBlockHash: Hex; evidenceHash: Hex; challengeEvidenceHash: Hex; resolvers: readonly Address[];
  targetFdv: bigint; attestedFdv: bigint; yesPool: bigint; noPool: bigint; outcomeYes: boolean; feeBps: number; pairSymbol: string;
  graduationComplete: boolean | null;
};
type Position = { yes: bigint; no: bigint; claimed: boolean };
const V6_FACTORY = "0xac135da186de8325047ef2afd1d16d5971f731f7" as Address;
const launchCreatedEvent = parseAbiItem("event LaunchCreated(uint256 indexed launchId,address indexed launcher,address indexed token,address curve,string name,string symbol,string metadataURI,address pairCurrency,uint16 taxBps,uint64 packedWeights,address projectTreasury,uint256 targetPairUnits,uint256 netPersonal,uint256 giftNetTotal,bytes32 giftRoot,uint256 giftCount)");
const factoryAbi = [
  { type: "function", name: "isV6Token", stateMutability: "view", inputs: [{ name: "token", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "curveOf", stateMutability: "view", inputs: [{ name: "token", type: "address" }], outputs: [{ type: "address" }] },
] as const;
const curveValidationAbi = [
  { type: "function", name: "complete", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "pairCurrency", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;
const tokenValidationAbi = [
  { type: "function", name: "pairCurrency", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
async function findBlockAtOrBeforeTimestamp(target: bigint) {
  const latest = await publicClient.getBlock({ blockTag: "latest" });
  if (latest.timestamp < target) throw new Error("Launch time is later than the latest confirmed chain block.");
  let low = 0n, high = latest.number;
  while (low < high) {
    const middle = (low + high + 1n) / 2n;
    const block = await publicClient.getBlock({ blockNumber: middle });
    if (block.timestamp <= target) low = middle;
    else high = middle - 1n;
  }
  return publicClient.getBlock({ blockNumber: low });
}
const short = (value: string) => value.slice(0, 6) + "…" + value.slice(-4);
const fmt = (value: bigint, decimals: number) => Number(formatUnits(value, decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 });
const when = (value: bigint) => new Date(Number(value) * 1000).toLocaleString();
const typeName = (value: number) => ["Graduation", "12-hour FDV", "24-hour FDV"][value] || "Unknown";
const statusName = (value: number) => ["Open", "Challenge period", "Disputed", "Resolved", "Voided"][value] || "Unknown";

export default function V2Markets({ v2Address, account, wallet }: {
  v2Address?: string; account?: Address; wallet?: WalletClient;
}) {
  const [markets, setMarkets] = useState<V2Market[]>([]);
  const [positions, setPositions] = useState<Record<string, Position>>({});
  const [stakeToken, setStakeToken] = useState<Address>();
  const [stakeSymbol, setStakeSymbol] = useState("tUSD");
  const [stakeDecimals, setStakeDecimals] = useState(6);
  const [feeBps, setFeeBps] = useState(0);
  const [owner, setOwner] = useState<Address>();
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [marketType, setMarketType] = useState("1");
  const [token, setToken] = useState("");
  const [curve, setCurve] = useState("");
  const [pairCurrency, setPairCurrency] = useState("");
  const [launchAt, setLaunchAt] = useState("");
  const [observationAt, setObservationAt] = useState("");
  const [closeAt, setCloseAt] = useState("");
  const [targetFdv, setTargetFdv] = useState("");
  const [maxLag, setMaxLag] = useState("600");
  const [section, setSection] = useState<"markets" | "portfolio">("markets");
  const [marketFilter, setMarketFilter] = useState<"all" | "open" | "resolving" | "resolved">("open");

  const contractAddress = (v2Address || "") as Address;
  const configured = /^0x[a-fA-F0-9]{40}$/.test(contractAddress);
  const isOwner = Boolean(account && owner && account.toLowerCase() === owner.toLowerCase());

  const refresh = useCallback(async () => {
    if (!configured) return;
    try {
      const [count, admin, stake, fee] = await Promise.all([
        publicClient.readContract({ address: contractAddress, abi, functionName: "marketCount" }),
        publicClient.readContract({ address: contractAddress, abi, functionName: "owner" }),
        publicClient.readContract({ address: contractAddress, abi, functionName: "stakeToken" }),
        publicClient.readContract({ address: contractAddress, abi, functionName: "feeBps" }),
      ]);
      setOwner(admin); setStakeToken(stake); setFeeBps(Number(fee));
      const [sym, dec] = await Promise.all([
        publicClient.readContract({ address: stake, abi: erc20Abi, functionName: "symbol" }).catch(() => "tUSD"),
        publicClient.readContract({ address: stake, abi: erc20Abi, functionName: "decimals" }).catch(() => 6),
      ]);
      setStakeSymbol(sym as string); setStakeDecimals(Number(dec));
      const ids = Array.from({ length: Number(count) }, (_, index) => BigInt(index + 1));
      const rows = await Promise.all(ids.map(async id => {
        const raw = await publicClient.readContract({ address: contractAddress, abi, functionName: "getMarket", args: [id] });
        const graduationComplete = raw.marketType === 0
          ? await publicClient.readContract({ address: raw.curve, abi: curveValidationAbi, functionName: "complete" }).catch(() => null)
          : null;
        return {
          id, marketType: raw.marketType, status: raw.status, token: raw.token, curve: raw.curve,
          pairCurrency: raw.pairCurrency, launchAt: raw.launchAt, observationAt: raw.observationAt,
          closeAt: raw.closeAt, maxObservationLag: raw.maxObservationLag, challengeEndsAt: raw.challengeEndsAt,
          observationBlock: raw.observationBlock, observationTimestamp: raw.observationTimestamp,
          observationBlockHash: raw.observationBlockHash, evidenceHash: raw.evidenceHash,
          challengeEvidenceHash: raw.challengeEvidenceHash, resolvers: raw.resolvers,
          targetFdv: raw.targetFdv, attestedFdv: raw.attestedFdv, yesPool: raw.yesPool,
          noPool: raw.noPool, outcomeYes: raw.outcomeYes, feeBps: Number(raw.feeBps), graduationComplete,
          pairSymbol: raw.marketType === 0 ? "" : await publicClient.readContract({ address: raw.pairCurrency, abi: erc20Abi, functionName: "symbol" }).catch(() => short(raw.pairCurrency)),
        } satisfies V2Market;
      }));
      setMarkets(rows.reverse());
      if (account) {
        const entries = await Promise.all(rows.map(async market => {
          const [yes, no, claimed] = await Promise.all([
            publicClient.readContract({ address: contractAddress, abi, functionName: "yesStake", args: [market.id, account] }),
            publicClient.readContract({ address: contractAddress, abi, functionName: "noStake", args: [market.id, account] }),
            publicClient.readContract({ address: contractAddress, abi, functionName: "hasClaimed", args: [market.id, account] }),
          ]);
          return [market.id.toString(), { yes, no, claimed }] as const;
        }));
        setPositions(Object.fromEntries(entries));
      } else setPositions({});
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to read Launchcast V2.");
    }
  }, [account, configured, contractAddress]);

  useEffect(() => {
    void refresh();
    // Keep expiry and V6 curve completion status fresh while the market board is open.
    const interval = window.setInterval(() => { void refresh(); }, 30_000);
    return () => window.clearInterval(interval);
  }, [refresh]);
  const portfolio = useMemo(() => markets.filter(m => {
    const p = positions[m.id.toString()]; return p && (p.yes > 0n || p.no > 0n);
  }), [markets, positions]);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const isSettled = (market: V2Market) => market.status === 3 || market.status === 4;
  const isClaimable = (market: V2Market, position?: Position) => {
    if (!position || position.claimed || (position.yes === 0n && position.no === 0n)) return false;
    if (market.status === 4) return true;
    if (market.status !== 3) return false;
    const winningPool = market.outcomeYes ? market.yesPool : market.noPool;
    return winningPool === 0n || (market.outcomeYes ? position.yes : position.no) > 0n;
  };
  const positionOutcome = (market: V2Market, position: Position) => {
    if (market.status === 4) return "REFUNDED";
    if (market.status !== 3) return "PENDING";
    const winningPool = market.outcomeYes ? market.yesPool : market.noPool;
    if (winningPool === 0n) return "REFUNDED";
    const winningStake = market.outcomeYes ? position.yes : position.no;
    if (winningStake === 0n) return "LOST";
    const losingPool = market.outcomeYes ? market.noPool : market.yesPool;
    const fee = losingPool * BigInt(market.feeBps) / 10000n;
    const payout = winningStake + (losingPool - fee) * winningStake / winningPool;
    const net = payout - position.yes - position.no;
    return net > 0n ? "WON" : net < 0n ? "LOST" : "BREAK EVEN";
  };
  const history = portfolio.filter(market => isSettled(market));
  const wins = history.filter(market => positionOutcome(market, positions[market.id.toString()]) === "WON").length;
  const losses = history.filter(market => positionOutcome(market, positions[market.id.toString()]) === "LOST").length;
  const claimableCount = history.filter(market => isClaimable(market, positions[market.id.toString()])).length;
  const visibleMarkets = markets.filter(market => {
    const closed = now >= market.closeAt;
    if (marketFilter === "open") return market.status === 0 && !closed && (market.marketType !== 0 || market.graduationComplete === false);
    if (marketFilter === "resolving") return (market.status === 0 && (closed || (market.marketType === 0 && market.graduationComplete !== false))) || market.status === 1 || market.status === 2;
    if (marketFilter === "resolved") return isSettled(market);
    return true;
  });
  const estimatePayout = (market: V2Market, sideYes: boolean, stake: bigint) => {
    const winningPool = (sideYes ? market.yesPool : market.noPool) + stake;
    const losingPool = sideYes ? market.noPool : market.yesPool;
    const fee = losingPool * BigInt(market.feeBps) / 10000n;
    const payout = stake + (winningPool > 0n ? (losingPool - fee) * stake / winningPool : 0n);
    return { payout, profit: payout - stake, multiplier: Number((payout * 10000n) / stake) / 10000 };
  };

  async function transact(label: string, action: (client: WalletClient, user: Address) => Promise<Hex>) {
    if (!wallet || !account) { setError("Connect your wallet first."); return; }
    setBusy(label); setError(""); setNotice("");
    try {
      const hash = await action(wallet, account);
      setNotice(label + ": transaction submitted. Waiting for confirmation…");
      await publicClient.waitForTransactionReceipt({ hash });
      setNotice(label + ": confirmed on Robinhood Chain Testnet.");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : label + " failed.");
    } finally { setBusy(""); }
  }

  async function bet(market: V2Market, sideYes: boolean) {
    if (!stakeToken || !wallet || !account) return;
    let amount: bigint;
    try { amount = parseUnits(amounts[market.id.toString()] || "", stakeDecimals); if (amount <= 0n) throw new Error("Enter a stake greater than zero."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Invalid stake."); return; }
    await transact("Place " + (sideYes ? "YES" : "NO") + " position", async (client, user) => {
      const allowance = await publicClient.readContract({ address: stakeToken, abi: erc20Abi, functionName: "allowance", args: [user, contractAddress] });
      if (allowance < amount) {
        const approval = await client.writeContract({ account: user, chain, address: stakeToken, abi: erc20Abi, functionName: "approve", args: [contractAddress, amount] });
        await publicClient.waitForTransactionReceipt({ hash: approval });
      }
      return client.writeContract({ account: user, chain, address: contractAddress, abi, functionName: "placeBet", args: [market.id, sideYes, amount] });
    });
  }

  async function create() {
    if (!wallet || !account || !isOwner) { setError("Only the V2 contract owner can create markets."); return; }
    try {
      const marketKind = Number(marketType);
      const tokenAddress = token as Address;
      const curveAddress = curve as Address;
      const pairAddress = marketKind === 0 ? ZERO : pairCurrency as Address;
      if (!/^0x[a-fA-F0-9]{40}$/.test(token) || !/^0x[a-fA-F0-9]{40}$/.test(curve)) throw new Error("Enter valid token and curve contract addresses.");
      if (marketKind !== 0 && !/^0x[a-fA-F0-9]{40}$/.test(pairCurrency)) throw new Error("Enter a valid pair-currency contract address for FDV markets.");
      const launch = BigInt(Math.floor(new Date(launchAt).getTime() / 1000));
      const observation = BigInt(Math.floor(new Date(observationAt).getTime() / 1000));
      const close = BigInt(Math.floor(new Date(closeAt).getTime() / 1000));
      if (!launch || !observation || !close) throw new Error("Enter all three market dates.");
      const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
      if (launch >= observation || close <= nowSeconds || close >= observation) throw new Error("Launch must precede observation, and betting must close in the future before observation.");
      const lag = BigInt(maxLag);
      const target = marketKind === 0 ? 0n : parseUnits(targetFdv, 18);
      if (marketKind !== 0 && target <= 0n) throw new Error("Enter a positive FDV threshold.");
      if (lag <= 0n || lag > 600n) throw new Error("Observation lag must be between 1 and 600 seconds.");
      // Verify the launch timestamp against the canonical V6 LaunchCreated event. A wrong launchAt
      // would shift the 12h/24h observation and could make the market unresolvable.
      const launchBlock = await findBlockAtOrBeforeTimestamp(launch);
      const latestBlock = await publicClient.getBlock({ blockTag: "latest" });
      const fromBlock = launchBlock.number > 5_000n ? launchBlock.number - 5_000n : 0n;
      const launchLogs = await publicClient.getLogs({ address: V6_FACTORY, event: launchCreatedEvent, args: { token: tokenAddress }, fromBlock, toBlock: latestBlock.number });
      if (launchLogs.length !== 1) throw new Error(`Expected one canonical V6 LaunchCreated event for this token; found ${launchLogs.length}.`);
      const launchLog = launchLogs[0];
      if (launchLog.blockNumber === null || launchLog.blockHash === null || launchLog.args.curve?.toLowerCase() !== curveAddress.toLowerCase()) throw new Error("The V6 launch event is incomplete or points to a different curve.");
      const eventBlock = await publicClient.getBlock({ blockNumber: launchLog.blockNumber });
      if (eventBlock.hash?.toLowerCase() !== launchLog.blockHash.toLowerCase() || eventBlock.timestamp !== launch) throw new Error("Launch time must exactly match the canonical V6 LaunchCreated block timestamp.");
      const [isV6, mappedCurve] = await Promise.all([
        publicClient.readContract({ address: V6_FACTORY, abi: factoryAbi, functionName: "isV6Token", args: [tokenAddress] }),
        publicClient.readContract({ address: V6_FACTORY, abi: factoryAbi, functionName: "curveOf", args: [tokenAddress] }),
      ]);
      if (!isV6 || mappedCurve.toLowerCase() !== curveAddress.toLowerCase()) {
        throw new Error("This token and curve are not registered together in the VibeVibe V6 factory.");
      }
      const [complete, curvePair, tokenPair] = await Promise.all([
        publicClient.readContract({ address: curveAddress, abi: curveValidationAbi, functionName: "complete" }),
        publicClient.readContract({ address: curveAddress, abi: curveValidationAbi, functionName: "pairCurrency" }),
        publicClient.readContract({ address: tokenAddress, abi: tokenValidationAbi, functionName: "pairCurrency" }),
      ]);
      if (curvePair.toLowerCase() !== tokenPair.toLowerCase()) throw new Error("The token and curve pair-currency settings do not match.");
      if (marketKind === 0 && complete) throw new Error("Graduation markets require a token that has not graduated yet.");
      if (marketKind === 0 && curvePair.toLowerCase() !== ZERO.toLowerCase()) throw new Error("Graduation markets currently support only native-ETH-paired V6 tokens.");
      if (marketKind !== 0) {
        if (!complete) throw new Error("FDV markets are currently limited to graduated V6 tokens.");
        if (curvePair.toLowerCase() !== pairAddress.toLowerCase()) throw new Error("The selected pair currency does not match the token and curve contracts.");
      }
      if (marketKind === 1 && observation !== launch + 12n * 3600n) throw new Error("A 12-hour market must observe exactly 12 hours after launch.");
      if (marketKind === 2 && observation !== launch + 24n * 3600n) throw new Error("A 24-hour market must observe exactly 24 hours after launch.");
      await transact("Create V2 market", (client, user) => client.writeContract({
        account: user, chain, address: contractAddress, abi, functionName: "createMarket",
        args: [marketKind, tokenAddress, curveAddress, pairAddress, launch, observation, close, lag, target],
      }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Market details are invalid."); }
  }

  if (!configured) return <section className="v2-panel">
    <div className="eyebrow">LAUNCHCAST V2</div><h1>V2 markets are being prepared</h1>
    <p>The V2 market interface is now part of the app. It will activate when the separately audited V2 contract is deployed and its address is added to the public deployment configuration.</p>
    <p className="v2-warning">Your current deployment is V1. V1 markets and funds are separate; this page will not send V2 transactions to the V1 contract.</p>
  </section>;

  return <section className="v2-panel">
    <div className="v2-heading"><div><span className="eyebrow">LAUNCHCAST V2 · ROBINHOOD TESTNET</span><h1>Pooled prediction markets</h1><p>Graduation and 12/24-hour FDV markets with resolver attestations, challenges and refundable void outcomes.</p></div><button className="v2-refresh" onClick={() => void refresh()}>↻ Refresh</button></div>
    <div className="v2-summary"><div><b>{markets.filter(m => m.status === 0 && now < m.closeAt && (m.marketType !== 0 || m.graduationComplete === false)).length}</b><span>Open markets</span></div><div><b>{portfolio.length}</b><span>Your positions</span></div><div><b>{wins}</b><span>Wins</span></div><div><b>{losses}</b><span>Losses</span></div><div><b>{claimableCount}</b><span>Claimable</span></div><div><b>{(feeBps / 100).toFixed(2)}%</b><span>Market fee</span></div><div><b>{stakeSymbol}</b><span>Stake asset</span></div></div>
    <div className="v2-section-tabs"><button className={section === "markets" ? "selected" : ""} onClick={() => setSection("markets")}>Markets</button><button className={section === "portfolio" ? "selected" : ""} onClick={() => setSection("portfolio")}>My portfolio <span>{portfolio.length}</span></button></div>
    {notice && <div className="notice success">{notice}</div>}{error && <div className="notice danger">{error}</div>}
    {section === "markets" ? <><div className="v2-filter-tabs">{(["all", "open", "resolving", "resolved"] as const).map(filter => <button key={filter} className={marketFilter === filter ? "selected" : ""} onClick={() => setMarketFilter(filter)}>{filter === "all" ? "All markets" : filter === "open" ? "Open" : filter === "resolving" ? "Resolving" : "Resolved"}</button>)}</div>{visibleMarkets.length === 0 ? <div className="empty"><h3>No markets in this view</h3><p>Try another market filter or check back after a new market is created.</p></div> : <div className="v2-market-list">{visibleMarkets.map(market => {
      const id = market.id.toString(), position = positions[id], total = market.yesPool + market.noPool;
      const closed = now >= market.closeAt || (market.marketType === 0 && market.graduationComplete !== false);
      const canFinalize = market.status === 1 && BigInt(Math.floor(Date.now() / 1000)) > market.challengeEndsAt;
      const canVoidDispute = market.status === 2;
      const canVoidTimeout = market.status === 0 && BigInt(Math.floor(Date.now() / 1000)) > market.observationAt + 86400n;
      const hasPosition = Boolean(position && (position.yes > 0n || position.no > 0n));
      return <article className="v2-market-card" key={id}>
        <div className="v2-card-top"><span className={"v2-status status-" + market.status}>{market.status === 0 && closed ? "Betting closed" : statusName(market.status)}</span><span>#{id} · {typeName(market.marketType)}</span></div>
        <h3>{market.marketType === 0 ? "Will this token graduate by the observation time?" : `Will FDV reach ${fmt(market.targetFdv, 18)} ${market.pairSymbol} by the observation time?`}</h3>
        <div className="v2-muted">Token · {short(market.token)}</div>
        <div className="v2-addresses"><span>Token <a href={"https://explorer.testnet.chain.robinhood.com/address/" + market.token} target="_blank" rel="noreferrer">{short(market.token)} ↗</a></span><span>Curve <a href={"https://explorer.testnet.chain.robinhood.com/address/" + market.curve} target="_blank" rel="noreferrer">{short(market.curve)} ↗</a></span></div>
        <div className="v2-dates"><span>Closes <b>{when(market.closeAt)}</b></span><span>Observation <b>{when(market.observationAt)}</b></span></div>
        {market.marketType !== 0 && <div className="v2-target">Target <b>{fmt(market.targetFdv, 18)} {market.pairSymbol}</b>{market.status >= 1 && <span> · Attested {fmt(market.attestedFdv, 18)} {market.pairSymbol}</span>}</div>}
        {market.observationBlock > 0n && <div className="v2-evidence"><span>Observation block <b>{market.observationBlock.toString()}</b></span><span>Observed at <b>{when(market.observationTimestamp)}</b></span><span>Resolver evidence <b>{short(market.evidenceHash)}</b></span>{market.status === 2 && <span>Conflicting evidence <b>{short(market.challengeEvidenceHash)}</b></span>}</div>}
        <div className="v2-resolvers"><span>Market resolver committee</span>{market.resolvers.map((resolver, index) => <a key={resolver} href={"https://explorer.testnet.chain.robinhood.com/address/" + resolver} target="_blank" rel="noreferrer">R{index + 1} · {short(resolver)}</a>)}</div>
        <div className="v2-market-fee">Fee locked at {(market.feeBps / 100).toFixed(2)}% for this market</div>
        <div className="v2-pools"><div><span>YES pool</span><b>{fmt(market.yesPool, stakeDecimals)} {stakeSymbol}</b></div><div><span>NO pool</span><b>{fmt(market.noPool, stakeDecimals)} {stakeSymbol}</b></div><div><span>Total pooled</span><b>{fmt(total, stakeDecimals)} {stakeSymbol}</b></div></div>
        {hasPosition && <div className="v2-position">Your position · YES {fmt(position!.yes, stakeDecimals)} / NO {fmt(position!.no, stakeDecimals)} {stakeSymbol}{position!.claimed ? " · Claimed" : ""}</div>}
        {market.status === 0 && !closed && account && <div className="v2-bet"><input inputMode="decimal" placeholder={"Stake in " + stakeSymbol} value={amounts[id] || ""} onChange={event => setAmounts(old => ({ ...old, [id]: event.target.value }))}/><button disabled={Boolean(busy)} onClick={() => void bet(market, true)}>Back YES</button><button disabled={Boolean(busy)} onClick={() => void bet(market, false)}>Back NO</button>{(() => { try { const stake = parseUnits(amounts[id] || "", stakeDecimals); if (stake <= 0n) return null; const yes = estimatePayout(market, true, stake), no = estimatePayout(market, false, stake); return <div className="v2-estimates"><span>YES estimate <b>{yes.multiplier.toFixed(2)}×</b><small>{fmt(yes.payout, stakeDecimals)} {stakeSymbol} payout</small></span><span>NO estimate <b>{no.multiplier.toFixed(2)}×</b><small>{fmt(no.payout, stakeDecimals)} {stakeSymbol} payout</small></span><small>Indicative only. Other stakes can change the final payout.</small></div>; } catch { return null; } })()}</div>}
        {market.status === 0 && !closed && !account && <p className="v2-muted">Connect your wallet to take a position.</p>}
        {market.status === 0 && closed && <p className="v2-muted">Betting is closed. The market is waiting for its scheduled observation and resolver attestation.</p>}
        {market.status === 1 && <p className="v2-muted">Attested outcome: <b>{market.outcomeYes ? "YES" : "NO"}</b>. Challenge window ends {when(market.challengeEndsAt)}.</p>}
        {market.status === 3 && <p className="v2-result">Resolved · {market.outcomeYes ? "YES won" : "NO won"}</p>}
        {market.status === 4 && <p className="v2-result">Voided · both sides can reclaim their stakes.</p>}
        {market.status === 1 && canFinalize && account && <button className="v2-action" disabled={Boolean(busy)} onClick={() => void transact("Finalize market", (client, user) => client.writeContract({ account: user, chain, address: contractAddress, abi, functionName: "finalizeMarket", args: [market.id] }))}>Finalize result</button>}
        {canVoidDispute && account && <button className="v2-action" disabled={Boolean(busy)} onClick={() => void transact("Void disputed market", (client, user) => client.writeContract({ account: user, chain, address: contractAddress, abi, functionName: "voidDisputedMarket", args: [market.id] }))}>Void disputed market</button>}
        {canVoidTimeout && account && <button className="v2-action" disabled={Boolean(busy)} onClick={() => void transact("Void unattested market", (client, user) => client.writeContract({ account: user, chain, address: contractAddress, abi, functionName: "voidUnattestedMarket", args: [market.id] }))}>Refund expired market</button>}
        {isClaimable(market, position) && account && <button className="v2-claim" disabled={Boolean(busy)} onClick={() => void transact(market.status === 4 || (market.status === 3 && (market.outcomeYes ? market.yesPool : market.noPool) === 0n) ? "Refund V2 position" : "Claim V2 winnings", (client, user) => client.writeContract({ account: user, chain, address: contractAddress, abi, functionName: "claim", args: [market.id] }))}>{market.status === 4 || (market.status === 3 && (market.outcomeYes ? market.yesPool : market.noPool) === 0n) ? "Claim stake refund" : "Claim winnings"}</button>}
        {hasPosition && isSettled(market) && <p className="v2-result">Your result: {positionOutcome(market, position!)}{position!.claimed ? " · Processed" : ""}</p>}
      </article>;
    })}</div>}</> : <section className="v2-portfolio"><div className="v2-portfolio-heading"><div><span className="eyebrow">YOUR ON-CHAIN RECORD</span><h2>Position history</h2><p>Every position is read from the V2 contract for the connected wallet.</p></div><div className="v2-history-counts"><span><b>{wins}</b> Wins</span><span><b>{losses}</b> Losses</span><span><b>{claimableCount}</b> Claimable</span></div></div>{!account ? <div className="empty"><h3>Connect your wallet</h3><p>Your open positions and settled history will appear here.</p></div> : portfolio.length === 0 ? <div className="empty"><h3>No positions yet</h3><p>When you back a YES or NO outcome, it will be recorded here.</p></div> : <div className="v2-market-list">{portfolio.map(market => { const position = positions[market.id.toString()]; const outcome = positionOutcome(market, position); const claimable = isClaimable(market, position); const winningPool = market.outcomeYes ? market.yesPool : market.noPool; const losingPool = market.outcomeYes ? market.noPool : market.yesPool; const winningStake = market.outcomeYes ? position.yes : position.no; const fee = losingPool * BigInt(market.feeBps) / 10000n; const payout = market.status === 4 || (market.status === 3 && winningPool === 0n) ? position.yes + position.no : market.status === 3 && winningStake > 0n ? winningStake + (losingPool - fee) * winningStake / winningPool : 0n; const net = payout - position.yes - position.no; return <article className="v2-market-card v2-history-card" key={market.id.toString()}><div className="v2-card-top"><span className={"v2-status status-" + market.status}>{statusName(market.status)}</span><span>#{market.id.toString()} · {typeName(market.marketType)}</span></div><h3>{market.marketType === 0 ? "Graduation market" : "FDV target · " + fmt(market.targetFdv, 18) + " " + market.pairSymbol}</h3><div className="v2-position">YES {fmt(position.yes, stakeDecimals)} / NO {fmt(position.no, stakeDecimals)} {stakeSymbol}</div><div className="v2-history-result"><span>Outcome <b>{outcome}</b></span><span>Total staked <b>{fmt(position.yes + position.no, stakeDecimals)} {stakeSymbol}</b></span><span>{market.status === 4 || (market.status === 3 && winningPool === 0n) ? "Refund" : market.status === 3 ? "Payout" : "Payout"} <b>{isSettled(market) ? fmt(payout, stakeDecimals) + " " + stakeSymbol : "Pending"}</b></span><span>Net result <b>{isSettled(market) ? (net > 0n ? "+" : "") + fmt(net, stakeDecimals) + " " + stakeSymbol : "Pending"}</b></span></div><p className="v2-muted">{position.claimed ? "Payout/refund processed on-chain." : claimable ? "Your winnings or refund are ready to claim." : market.status === 3 && outcome === "LOST" ? "This position lost. No claim is available." : "Waiting for market resolution."}</p>{claimable && account && <button className="v2-claim" disabled={Boolean(busy)} onClick={() => void transact(market.status === 4 || (market.status === 3 && winningPool === 0n) ? "Refund V2 position" : "Claim V2 winnings", (client, user) => client.writeContract({ account: user, chain, address: contractAddress, abi, functionName: "claim", args: [market.id] }))}>{market.status === 4 || (market.status === 3 && winningPool === 0n) ? "Claim stake refund" : "Claim winnings"}</button>}</article>; })}</div>}</section>}
    {isOwner && section === "markets" && <section className="v2-create">
      <span className="eyebrow">OWNER CONTROLS</span><h2>Create a V2 market</h2>
      <label>Market type<select value={marketType} onChange={event => setMarketType(event.target.value)}><option value="0">Graduation</option><option value="1">FDV after 12 hours</option><option value="2">FDV after 24 hours</option></select></label>
      <label>Token contract<input value={token} onChange={event => setToken(event.target.value)} placeholder="0x…"/></label>
      <label>Curve contract<input value={curve} onChange={event => setCurve(event.target.value)} placeholder="0x…"/></label>
      {marketType !== "0" && <><label>Pair currency contract<input value={pairCurrency} onChange={event => setPairCurrency(event.target.value)} placeholder="0x…"/></label><label>Target FDV (pair units)<input value={targetFdv} onChange={event => setTargetFdv(event.target.value)} placeholder="e.g. 100"/></label></>}
      <label>Launch time<input type="datetime-local" value={launchAt} onChange={event => setLaunchAt(event.target.value)}/></label>
      <label>Observation time<input type="datetime-local" value={observationAt} onChange={event => setObservationAt(event.target.value)}/></label>
      <label>Betting closes<input type="datetime-local" value={closeAt} onChange={event => setCloseAt(event.target.value)}/></label>
      <label>Maximum observation lag (seconds)<input inputMode="numeric" value={maxLag} onChange={event => setMaxLag(event.target.value)}/></label>
      <button className="v2-create-button" disabled={Boolean(busy)} onClick={() => void create()}>{busy === "Create V2 market" ? "Creating…" : "Create V2 market"}</button>
      <p>FDV thresholds are denominated in the selected pair asset. Resolver attestation is a separate process; creating a market does not enable betting after its close time.</p>
    </section>}
  </section>;
}
