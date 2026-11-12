import { useCallback, useEffect, useState } from "react";
import { formatUnits, parseAbi, parseUnits, zeroAddress, type Address, type Hex, type WalletClient } from "viem";
import { chain, publicClient, FDV_ADDRESS, STAKE_TOKEN, V6_FACTORY, addr, short } from "./config";
import { CurvePanel } from "./curve";
import { deadline, fdvQuestion } from "./question";

export const fdvAbi = parseAbi([
  "function owner() view returns (address)",
  "function marketCount() view returns (uint256)",
  "function getMarket(uint256) view returns ((address token,address curve,address pairCurrency,uint64 closeAt,uint64 observeAt,uint8 status,bool outcomeYes,uint8 obsCount,uint64 lastObsTime,uint64 lastObsBlock,uint256 thresholdFdv,uint256 fdvAtCreation,uint256[3] obs,uint256 settledFdv,uint128 yesPool,uint128 noPool))",
  "function currentFdv(address) view returns (uint256 fdv,bool graduated,address curve,address pair)",
  "function yesStake(uint256,address) view returns (uint256)",
  "function noStake(uint256,address) view returns (uint256)",
  "function hasClaimed(uint256,address) view returns (bool)",
  "function claimable(uint256,address) view returns (uint256)",
  "function placeBet(uint256,bool,uint256)",
  "function observe(uint256)",
  "function settle(uint256)",
  "function claim(uint256) returns (uint256)",
  "function createMarket(address,uint256,uint64,uint64) returns (uint256)",
]);
const erc20 = parseAbi(["function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
const factoryAbi = parseAbi(["function tokenOfLaunch(uint256) view returns (address)", "function isV6Token(address) view returns (bool)"]);
export const OBS_WINDOW = 3600n;

export type FdvMarket = {
  id: bigint; token: Address; curve: Address; pairCurrency: Address; closeAt: bigint; observeAt: bigint; status: number; outcomeYes: boolean;
  obsCount: number; lastObsTime: bigint; thresholdFdv: bigint; fdvAtCreation: bigint; settledFdv: bigint; yesPool: bigint; noPool: bigint;
  name?: string; symbol?: string; pairSymbol: string; pairDecimals: number; fdvNow?: bigint; graduated?: boolean;
  yes: bigint; no: bigint; claimed: boolean; claimable: bigint;
};

async function pairMeta(pair: Address): Promise<[string, number]> {
  if (pair === zeroAddress) return ["ETH", 18];
  const [s, d] = await Promise.all([
    publicClient.readContract({ address: pair, abi: erc20, functionName: "symbol" }).catch(() => short(pair)),
    publicClient.readContract({ address: pair, abi: erc20, functionName: "decimals" }).catch(() => 18),
  ]);
  return [s as string, Number(d)];
}

export function useFdvMarkets(account?: Address) {
  const [markets, setMarkets] = useState<FdvMarket[]>([]);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      const count = await publicClient.readContract({ address: FDV_ADDRESS, abi: fdvAbi, functionName: "marketCount" });
      const ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i + 1)).reverse();
      const rows = await Promise.all(ids.map(async id => {
        const m = await publicClient.readContract({ address: FDV_ADDRESS, abi: fdvAbi, functionName: "getMarket", args: [id] });
        const [name, symbol, [pairSymbol, pairDecimals], live, pos] = await Promise.all([
          publicClient.readContract({ address: m.token, abi: erc20, functionName: "name" }).catch(() => undefined),
          publicClient.readContract({ address: m.token, abi: erc20, functionName: "symbol" }).catch(() => undefined),
          pairMeta(m.pairCurrency),
          publicClient.readContract({ address: FDV_ADDRESS, abi: fdvAbi, functionName: "currentFdv", args: [m.token] }).catch(() => undefined),
          account ? Promise.all([
            publicClient.readContract({ address: FDV_ADDRESS, abi: fdvAbi, functionName: "yesStake", args: [id, account] }),
            publicClient.readContract({ address: FDV_ADDRESS, abi: fdvAbi, functionName: "noStake", args: [id, account] }),
            publicClient.readContract({ address: FDV_ADDRESS, abi: fdvAbi, functionName: "hasClaimed", args: [id, account] }),
            publicClient.readContract({ address: FDV_ADDRESS, abi: fdvAbi, functionName: "claimable", args: [id, account] }),
          ]) : Promise.resolve([0n, 0n, false, 0n] as const),
        ]);
        return {
          id, token: m.token, curve: m.curve, pairCurrency: m.pairCurrency, closeAt: m.closeAt, observeAt: m.observeAt, status: m.status,
          outcomeYes: m.outcomeYes, obsCount: m.obsCount, lastObsTime: m.lastObsTime, thresholdFdv: m.thresholdFdv, fdvAtCreation: m.fdvAtCreation,
          settledFdv: m.settledFdv, yesPool: m.yesPool, noPool: m.noPool, name: name as string | undefined, symbol: symbol as string | undefined,
          pairSymbol, pairDecimals, fdvNow: live?.[0], graduated: live?.[1],
          yes: pos[0] as bigint, no: pos[1] as bigint, claimed: pos[2] as boolean, claimable: pos[3] as bigint,
        } satisfies FdvMarket;
      }));
      setMarkets(rows); setError("");
    } catch (e) { setError((e as Error)?.message?.split("\n")[0] || "Could not read FDV markets."); }
  }, [account]);
  useEffect(() => { void refresh(); const t = window.setInterval(() => void refresh(), 30_000); return () => window.clearInterval(t); }, [refresh]);
  return { markets, refresh, error };
}

export type Phase = "open" | "resolving" | "resolved";
export function fdvPhase(m: FdvMarket, now: bigint): Phase {
  if (m.status !== 0) return "resolved";
  return now < m.closeAt ? "open" : "resolving";
}

const fmt = (v: bigint, d: number) => Number(formatUnits(v, d)).toLocaleString(undefined, { maximumSignificantDigits: 5 });

type Tx = (label: string, run: (c: WalletClient, u: Address) => Promise<Hex>) => Promise<void>;

export function FdvCard({ m, account, busy, transact, stakeDecimals }: { m: FdvMarket; account?: Address; busy: string; transact: Tx; stakeDecimals: number }) {
  const [amount, setAmount] = useState("");
  const now = BigInt(Math.floor(Date.now() / 1000));
  const phase = fdvPhase(m, now);
  const inWindow = m.status === 0 && now >= m.observeAt && now <= m.observeAt + OBS_WINDOW && m.obsCount < 3;
  const spacingOk = m.obsCount === 0 || now >= m.lastObsTime + 30n;
  const canSettle = m.status === 0 && (m.obsCount >= 3 || now > m.observeAt + OBS_WINDOW);
  const total = m.yesPool + m.noPool;
  const statusLabel = m.status === 1 ? (m.outcomeYes ? "Resolved · YES" : "Resolved · NO") : m.status === 2 ? "Voided · refunds" : phase === "open" ? "Open" : now < m.observeAt ? "Betting closed" : "Observing";
  async function bet(yes: boolean) {
    let v: bigint;
    try { v = parseUnits(amount || "0", stakeDecimals); if (v <= 0n) throw new Error(); } catch { return; }
    await transact(`Place ${yes ? "YES" : "NO"} on FDV market #${m.id}`, async (c, u) => {
      const allowance = await publicClient.readContract({ address: STAKE_TOKEN, abi: erc20, functionName: "allowance", args: [u, FDV_ADDRESS] });
      if (allowance < v) { const h = await c.writeContract({ account: u, chain, address: STAKE_TOKEN, abi: erc20, functionName: "approve", args: [FDV_ADDRESS, v] }); await publicClient.waitForTransactionReceipt({ hash: h }); }
      return c.writeContract({ account: u, chain, address: FDV_ADDRESS, abi: fdvAbi, functionName: "placeBet", args: [m.id, yes, v] });
    });
  }
  return <article className="v2-market-card fdv-card">
    <div className="v2-card-top"><span className={"v2-status status-" + (m.status === 0 ? 0 : m.status === 1 ? 3 : 4)}>{statusLabel}</span><span><i className="kind-pill fdv">FDV · on-chain</i>#{m.id.toString()} · {m.graduated ? "graduated · v4 pool" : "on curve"}</span></div>
    <h3>{fdvQuestion(m.name, m.symbol, m.thresholdFdv, m.pairDecimals, m.pairSymbol, m.observeAt)}</h3>
    <div className="fdv-gauge">
      <div><span>FDV now</span><b className={m.fdvNow !== undefined && m.fdvNow >= m.thresholdFdv ? "up" : "down"}>{m.fdvNow !== undefined ? fmt(m.fdvNow, m.pairDecimals) : "—"} {m.pairSymbol}</b></div>
      <div><span>Target</span><b>{fmt(m.thresholdFdv, m.pairDecimals)} {m.pairSymbol}</b></div>
      <div><span>At listing</span><b>{fmt(m.fdvAtCreation, m.pairDecimals)} {m.pairSymbol}</b></div>
    </div>
    {!m.graduated && <CurvePanel curve={m.curve} title="Bonding curve now" />}
    <div className="v2-addresses"><span>Token <a href={addr(m.token)} target="_blank" rel="noreferrer">{short(m.token)} ↗</a></span><span>Pair {m.pairSymbol}</span></div>
    <div className="v2-dates"><span>Bets close <b>{deadline(m.closeAt)}</b></span><span>Observed <b>{deadline(m.observeAt)}</b> + 1h window</span></div>
    <div className="v2-pools"><div><span>YES pool</span><b>{fmt(m.yesPool, stakeDecimals)} tUSD</b></div><div><span>NO pool</span><b>{fmt(m.noPool, stakeDecimals)} tUSD</b></div><div><span>Total</span><b>{fmt(total, stakeDecimals)} tUSD</b></div></div>
    {(m.yes > 0n || m.no > 0n) && <div className="v2-position">Your position · YES {fmt(m.yes, stakeDecimals)} / NO {fmt(m.no, stakeDecimals)} tUSD{m.claimed ? " · Claimed" : ""}</div>}
    {phase === "open" && account && <div className="v2-bet"><input inputMode="decimal" placeholder="Stake in tUSD" value={amount} onChange={e => setAmount(e.target.value)} /><button disabled={!!busy} onClick={() => void bet(true)}>YES</button><button disabled={!!busy} onClick={() => void bet(false)}>NO</button></div>}
    {phase === "open" && !account && <p className="v2-muted">Connect your wallet to take a position.</p>}
    {m.status === 0 && m.obsCount > 0 && <p className="v2-muted">Observations recorded: {m.obsCount}/3</p>}
    {inWindow && account && <button className="v2-action" disabled={!!busy || !spacingOk} onClick={() => void transact(`Record FDV observation for #${m.id}`, (c, u) => c.writeContract({ account: u, chain, address: FDV_ADDRESS, abi: fdvAbi, functionName: "observe", args: [m.id] }))}>{spacingOk ? `Record observation (${m.obsCount + 1}/3)` : "Next observation in ~30s"}</button>}
    {canSettle && account && <button className="v2-action" disabled={!!busy} onClick={() => void transact(`Settle FDV market #${m.id}`, (c, u) => c.writeContract({ account: u, chain, address: FDV_ADDRESS, abi: fdvAbi, functionName: "settle", args: [m.id] }))}>Settle market</button>}
    {m.status === 1 && <p className="v2-result">Median FDV {fmt(m.settledFdv, m.pairDecimals)} {m.pairSymbol} → {m.outcomeYes ? "YES" : "NO"} won</p>}
    {m.claimable > 0n && account && <button className="v2-claim" disabled={!!busy} onClick={() => void transact(`Claim FDV market #${m.id}`, (c, u) => c.writeContract({ account: u, chain, address: FDV_ADDRESS, abi: fdvAbi, functionName: "claim", args: [m.id] }))}>Claim {fmt(m.claimable, stakeDecimals)} tUSD</button>}
  </article>;
}

const toLocal = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);

type IndexRow = [number, Address, string, string, number, Address, number, number];
type LaunchIndex = { generatedAt: number; pairSymbols: Record<string, string>; rows: IndexRow[] };

export function FdvCreate({ busy, transact, onDone }: { busy: string; transact: Tx; onDone: () => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState<LaunchIndex | null>(null);
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<"all" | "graduated" | "nonEth" | "older">("all");
  useEffect(() => { fetch("/data/v6-all-launches.json").then(r => r.json()).then(setIndex).catch(() => undefined); }, []);
  const pairSym = (p: string) => index?.pairSymbols[p] ?? (p === zeroAddress ? "ETH" : short(p as Address));
  const nowS = Date.now() / 1000;
  const q = search.trim().toLowerCase().replace(/^#/, "");
  const results = (index?.rows ?? []).filter(r => {
    if (kind === "graduated" && !r[4]) return false;
    if (kind === "nonEth" && r[5] === zeroAddress) return false;
    if (kind === "older" && nowS - r[7] < 2 * 86400) return false;
    if (!q) return true;
    return String(r[0]) === q || r[2].toLowerCase().includes(q) || r[3].toLowerCase().includes(q) || r[1].toLowerCase() === q;
  }).slice(0, 40);
  const [info, setInfo] = useState<{ token: Address; name?: string; symbol?: string; fdv: bigint; graduated: boolean; pairSymbol: string; pairDecimals: number } | null>(null);
  const [err, setErr] = useState("");
  const [threshold, setThreshold] = useState("");
  const [observeAt, setObserveAt] = useState(toLocal(new Date(Date.now() + 86400_000)));
  const [closeAt, setCloseAt] = useState(toLocal(new Date(Date.now() + 82800_000)));
  async function lookup(override?: string) {
    setErr(""); setInfo(null);
    try {
      const q = (override ?? query).trim().replace(/^#/, "");
      let token: Address;
      if (/^0x[0-9a-fA-F]{40}$/.test(q)) token = q as Address;
      else if (/^\d+$/.test(q)) token = await publicClient.readContract({ address: V6_FACTORY, abi: factoryAbi, functionName: "tokenOfLaunch", args: [BigInt(q)] });
      else throw new Error("Enter a token address or a V6 launch number like #1064.");
      const [fdv, graduated, , pair] = await publicClient.readContract({ address: FDV_ADDRESS, abi: fdvAbi, functionName: "currentFdv", args: [token] });
      const [name, symbol, [pairSymbol, pairDecimals]] = await Promise.all([
        publicClient.readContract({ address: token, abi: erc20, functionName: "name" }).catch(() => undefined),
        publicClient.readContract({ address: token, abi: erc20, functionName: "symbol" }).catch(() => undefined),
        pairMeta(pair),
      ]);
      setInfo({ token, name: name as string | undefined, symbol: symbol as string | undefined, fdv, graduated, pairSymbol, pairDecimals });
      setThreshold(Number(formatUnits(fdv * 3n / 2n, pairDecimals)).toPrecision(4));
    } catch (e) { setErr((e as { shortMessage?: string })?.shortMessage || (e as Error).message.split("\n")[0]); }
  }
  function preset(secs: number) {
    const now = Date.now();
    setObserveAt(toLocal(new Date(now + secs * 1000)));
    setCloseAt(toLocal(new Date(now + (secs - Math.min(3600, Math.round(secs / 6))) * 1000)));
  }
  async function create() {
    if (!info) return;
    try {
      const t = parseUnits(threshold, info.pairDecimals);
      const o = BigInt(Math.floor(new Date(observeAt).getTime() / 1000)), c = BigInt(Math.floor(new Date(closeAt).getTime() / 1000));
      if (t <= 0n || c >= o || c * 1000n <= BigInt(Date.now())) throw new Error("Check the threshold and times: betting must close in the future, before the observation time.");
      await transact("Create FDV market", (cl, u) => cl.writeContract({ account: u, chain, address: FDV_ADDRESS, abi: fdvAbi, functionName: "createMarket", args: [info.token, t, c, o] }));
      onDone();
    } catch (e) { setErr((e as Error).message.split("\n")[0]); }
  }
  return <section className="v2-create">
    <span className="eyebrow">OWNER CONTROLS · ANY LAUNCH</span><h2>Create an FDV market</h2>
    <p>Works for every VibeVibe V6 launch: any age, still on its curve or graduated, and any pair. It settles from on-chain state as the median of up to 3 observations in the hour after the deadline.</p>
    <label>Token address or launch number<div className="fdv-lookup"><input value={query} onChange={e => setQuery(e.target.value)} placeholder="0x… or #1064" /><button type="button" className="v2-action" onClick={() => void lookup()}>Look up</button></div></label>
    <div className="fdv-picker">
      <div className="fdv-picker-head"><input value={search} onChange={e => setSearch(e.target.value)} placeholder={index ? `Search all ${index.rows.length.toLocaleString()} V6 launches by name, ticker or #` : "Loading launch index…"} aria-label="Search all launches" />
        <div className="v2-presets">{([["all", "All"], ["graduated", "Graduated"], ["nonEth", "Non-ETH pair"], ["older", "Older than 2d"]] as const).map(([k, l]) => <button key={k} type="button" className={kind === k ? "selected" : ""} onClick={() => setKind(k)}>{l}</button>)}</div></div>
      {(q || kind !== "all") && <div className="fdv-results">{results.length === 0 ? <p className="v2-muted">No launches match.</p> : results.map(r => <button type="button" key={r[0]} onClick={() => { setQuery(r[1]); setSearch(""); void lookup(r[1]); }}>
        <b>#{r[0]} {r[3] || r[2]}</b><span>${r[2]} · {pairSym(r[5])} pair · {r[4] ? "graduated" : `${r[6].toFixed(1)}%`} · {Math.max(0, Math.round((nowS - r[7]) / 86400))}d old</span></button>)}</div>}
      <p className="v2-muted">Index of every V6 launch, regenerated with <code>node web/scripts/build-launch-index.mjs</code>. Brand-new launches: paste the token address or launch number above.</p>
    </div>
    {err && <div className="notice danger">{err}</div>}
    {info && <>
      <div className="fdv-gauge"><div><span>Token</span><b>{info.name || short(info.token)} {info.symbol ? `(${info.symbol})` : ""}</b></div><div><span>FDV now</span><b>{fmt(info.fdv, info.pairDecimals)} {info.pairSymbol}</b></div><div><span>State</span><b>{info.graduated ? "Graduated" : "On curve"}</b></div></div>
      <div className="v2-presets"><span>Threshold</span>{[0.5, 0.8, 1.25, 1.5, 2, 3].map(x => <button key={x} type="button" onClick={() => setThreshold(Number(formatUnits(info.fdv * BigInt(Math.round(x * 100)) / 100n, info.pairDecimals)).toPrecision(4))}>{x}×</button>)}</div>
      <label>FDV threshold ({info.pairSymbol})<input value={threshold} onChange={e => setThreshold(e.target.value)} /></label>
      <div className="v2-presets"><span>Deadline</span>{([["1 hour", 3600], ["24 hours", 86400], ["7 days", 604800]] as const).map(([l, s]) => <button key={l} type="button" onClick={() => preset(s)}>{l}</button>)}</div>
      <label>Observation time<input type="datetime-local" step="1" value={observeAt} onChange={e => setObserveAt(e.target.value)} /></label>
      <label>Betting closes<input type="datetime-local" step="1" value={closeAt} onChange={e => setCloseAt(e.target.value)} /></label>
      <button className="v2-create-button" disabled={!!busy} onClick={() => void create()}>{busy === "Create FDV market" ? "Creating…" : "Create FDV market"}</button>
    </>}
  </section>;
}
