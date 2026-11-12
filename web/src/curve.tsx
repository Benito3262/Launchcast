import { useEffect, useState } from "react";
import { formatUnits, parseAbi, zeroAddress, type Address } from "viem";
import { publicClient, addr } from "./config";

/**
 * VibeVibe V6 bonding curve, reconstructed from on-chain reads.
 * Every V6 curve we checked satisfies a constant-product invariant with virtual reserves:
 *   (target/3 + pairPrincipal) * (1,066,666,667 - sold) = (target/3) * 1,066,666,667   (token units, 18 decimals)
 * 800M tokens are sold on the curve; at sold = 800M, pairPrincipal = target (graduation, ~4 ETH on ETH pairs).
 * Spot price (pair per token) = (V + P) / (Tv - s) = V * Tv / (Tv - s)^2. Fees/taxes are applied on top by the curve.
 */
export const CURVE_SUPPLY = 800_000_000;
export const TOTAL_SUPPLY = 1_000_000_000;
export const VIRTUAL_TOKENS = (CURVE_SUPPLY * 4) / 3;

export const curveAbi = parseAbi([
  "function token() view returns (address)",
  "function pairCurrency() view returns (address)",
  "function complete() view returns (bool)",
  "function sold() view returns (uint120)",
  "function targetPairUnits() view returns (uint256)",
  "function pairPrincipal() view returns (uint128)",
  "function createdAt() view returns (uint256)",
  "function currentRateBps() view returns (uint256)",
]);
const erc20Abi = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)", "function name() view returns (string)"]);

export type CurveState = {
  curve: Address; token: Address; pair: Address; pairSymbol: string; pairDecimals: number;
  complete: boolean; soldTokens: number; principal: number; target: number; createdAt: number; taxBps: number;
  progress: number; price: number; fdv: number; gradFdv: number; toGraduate: number; tokensLeft: number; fits: boolean;
  name?: string; symbol?: string;
};

export function priceAt(soldTokens: number, target: number) {
  const V = target / 3;
  const left = VIRTUAL_TOKENS - soldTokens;
  return (V * VIRTUAL_TOKENS) / (left * left);
}

export function deriveState(raw: { curve: Address; token: Address; pair: Address; pairSymbol: string; pairDecimals: number; complete: boolean; sold: bigint; principal: bigint; target: bigint; createdAt: bigint; taxBps: bigint; name?: string; symbol?: string }): CurveState {
  const soldTokens = Number(formatUnits(raw.sold, 18)); // whole tokens
  const principal = Number(formatUnits(raw.principal, raw.pairDecimals));
  const target = Number(formatUnits(raw.target, raw.pairDecimals));
  const V = target / 3;
  const fits = target > 0 && Math.abs(((V + principal) * (VIRTUAL_TOKENS - soldTokens)) / (V * VIRTUAL_TOKENS) - 1) < 0.02;
  const s = raw.complete ? CURVE_SUPPLY : soldTokens;
  const price = target > 0 ? priceAt(Math.min(s, CURVE_SUPPLY), target) : 0;
  return {
    ...raw, soldTokens, principal, target, createdAt: Number(raw.createdAt), taxBps: Number(raw.taxBps), complete: raw.complete,
    progress: raw.complete ? 1 : target > 0 ? Math.min(1, principal / target) : 0,
    price, fdv: price * TOTAL_SUPPLY, gradFdv: target > 0 ? priceAt(CURVE_SUPPLY, target) * TOTAL_SUPPLY : 0,
    toGraduate: raw.complete ? 0 : Math.max(0, target - principal), tokensLeft: raw.complete ? 0 : Math.max(0, CURVE_SUPPLY - soldTokens), fits,
  };
}

export async function readCurves(curves: Address[]): Promise<(CurveState | null)[]> {
  if (!curves.length) return [];
  const fields = ["token", "pairCurrency", "complete", "sold", "targetPairUnits", "pairPrincipal", "createdAt", "currentRateBps"] as const;
  const res = await publicClient.multicall({ allowFailure: true, contracts: curves.flatMap(c => fields.map(f => ({ address: c, abi: curveAbi, functionName: f }))) });
  const rows = curves.map((c, i) => {
    const r = res.slice(i * fields.length, (i + 1) * fields.length);
    if (r.some(x => x.status !== "success")) return null;
    const v = r.map(x => x.result) as unknown as [Address, Address, boolean, bigint, bigint, bigint, bigint, bigint];
    return { curve: c, token: v[0], pair: v[1], complete: v[2], sold: v[3], target: v[4], principal: v[5], createdAt: v[6], taxBps: v[7] };
  });
  const tokens = rows.filter(Boolean).map(r => r!.token);
  const pairs = [...new Set(rows.filter(r => r && r.pair !== zeroAddress).map(r => r!.pair))];
  const meta = await publicClient.multicall({ allowFailure: true, contracts: [
    ...tokens.flatMap(t => [{ address: t, abi: erc20Abi, functionName: "name" as const }, { address: t, abi: erc20Abi, functionName: "symbol" as const }]),
    ...pairs.flatMap(p => [{ address: p, abi: erc20Abi, functionName: "symbol" as const }, { address: p, abi: erc20Abi, functionName: "decimals" as const }]),
  ] });
  const names: Record<string, [string?, string?]> = {};
  tokens.forEach((t, i) => { names[t.toLowerCase()] = [meta[2 * i].result as string | undefined, meta[2 * i + 1].result as string | undefined]; });
  const pairMeta: Record<string, [string, number]> = {};
  pairs.forEach((p, i) => { const b = tokens.length * 2 + 2 * i; pairMeta[p.toLowerCase()] = [(meta[b].result as string) || "PAIR", Number(meta[b + 1].result ?? 18)]; });
  return rows.map(r => {
    if (!r) return null;
    const [pairSymbol, pairDecimals] = r.pair === zeroAddress ? ["ETH", 18] : pairMeta[r.pair.toLowerCase()] || ["PAIR", 18];
    const [name, symbol] = names[r.token.toLowerCase()] || [];
    return deriveState({ ...r, pairSymbol, pairDecimals, name, symbol });
  });
}

export function useCurve(curve?: string, refreshMs = 20_000) {
  const [state, setState] = useState<CurveState | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!curve || !/^0x[a-fA-F0-9]{40}$/.test(curve)) return;
    let live = true;
    const load = () => readCurves([curve as Address]).then(([s]) => { if (live) { setState(s); setError(s ? "" : "Curve not readable"); } }).catch(e => live && setError(String(e?.shortMessage || e?.message || e)));
    load();
    const t = window.setInterval(load, refreshMs);
    return () => { live = false; window.clearInterval(t); };
  }, [curve, refreshMs]);
  return { state, error };
}

export const fmtNum = (n: number, d = 4) => {
  if (!isFinite(n)) return "—";
  if (n === 0) return "0";
  if (Math.abs(n) < 1e-4) return n.toExponential(2);
  return n.toLocaleString(undefined, { maximumSignificantDigits: d });
};
export const fmtTokens = (n: number) => (n >= 1e6 ? (n / 1e6).toLocaleString(undefined, { maximumFractionDigits: 1 }) + "M" : n.toLocaleString(undefined, { maximumFractionDigits: 0 }));

export function CurveChart({ s, height = 150, compact = false }: { s: CurveState; height?: number; compact?: boolean }) {
  const W = 600, H = height, pad = compact ? 6 : 26;
  const maxP = priceAt(CURVE_SUPPLY, 1), minP = priceAt(0, 1);
  const x = (sold: number) => pad + (sold / CURVE_SUPPLY) * (W - pad * 2);
  const y = (p: number) => H - pad - ((p - minP) / (maxP - minP)) * (H - pad * 2);
  const pts: [number, number][] = [];
  for (let i = 0; i <= 80; i++) { const sold = (CURVE_SUPPLY * i) / 80; pts.push([x(sold), y(priceAt(sold, 1))]); }
  const cur = Math.min(CURVE_SUPPLY, s.complete ? CURVE_SUPPLY : s.soldTokens);
  const filled = pts.filter(([px]) => px <= x(cur)).concat([[x(cur), y(priceAt(cur, 1))]]);
  const line = pts.map(([a, b], i) => (i ? "L" : "M") + a.toFixed(1) + " " + b.toFixed(1)).join(" ");
  const area = "M" + pad + " " + (H - pad) + " " + filled.map(([a, b]) => "L" + a.toFixed(1) + " " + b.toFixed(1)).join(" ") + ` L${x(cur).toFixed(1)} ${H - pad} Z`;
  const cx = x(cur), cy = y(priceAt(cur, 1));
  return <svg className="curve-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Bonding curve, ${(s.progress * 100).toFixed(1)}% to graduation`} preserveAspectRatio="none">
    <defs><linearGradient id="cfill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="var(--accent)" stopOpacity=".35" /><stop offset="1" stopColor="var(--accent)" stopOpacity="0" /></linearGradient></defs>
    {!compact && [0.25, 0.5, 0.75].map(f => <line key={f} x1={pad} x2={W - pad} y1={pad + f * (H - pad * 2)} y2={pad + f * (H - pad * 2)} className="grid" />)}
    <path d={area} fill="url(#cfill)" />
    <path d={line} className="curve-line-future" />
    <path d={filled.map(([a, b], i) => (i ? "L" : "M") + a.toFixed(1) + " " + b.toFixed(1)).join(" ")} className="curve-line" />
    <line x1={x(CURVE_SUPPLY)} x2={x(CURVE_SUPPLY)} y1={pad} y2={H - pad} className="grad-line" />
    <circle cx={cx} cy={cy} r={compact ? 4 : 6} className="curve-dot" />
    {!compact && <>
      <text x={pad} y={H - 8} className="axis">0</text>
      <text x={W / 2} y={H - 8} className="axis" textAnchor="middle">tokens sold on curve</text>
      <text x={W - pad} y={H - 8} className="axis" textAnchor="end">800M · graduates</text>
      <text x={Math.min(cx + 10, W - 120)} y={Math.max(cy - 10, 16)} className="axis strong">{(s.progress * 100).toFixed(1)}%</text>
    </>}
  </svg>;
}

export function CurvePanel({ curve, title }: { curve: string; title?: string }) {
  const { state: s, error } = useCurve(curve);
  if (error && !s) return <div className="curve-panel muted">Bonding curve unavailable: {error}</div>;
  if (!s) return <div className="curve-panel skeleton" aria-busy="true"><div className="sk-line" /><div className="sk-block" /></div>;
  return <div className="curve-panel">
    <div className="curve-head">
      <span className="label">{title || "Bonding curve · live on-chain"}</span>
      <span className={"pill " + (s.complete ? "pill-done" : "pill-live")}>{s.complete ? "Graduated" : `${(s.progress * 100).toFixed(1)}% to graduation`}</span>
    </div>
    <CurveChart s={s} />
    <div className="progress"><i style={{ width: `${(s.progress * 100).toFixed(2)}%` }} /></div>
    <div className="stat-grid">
      <div><span>Raised</span><b>{fmtNum(s.principal)} / {fmtNum(s.target)} {s.pairSymbol}</b></div>
      <div><span>To graduate</span><b>{fmtNum(s.toGraduate)} {s.pairSymbol}</b></div>
      <div><span>Spot price</span><b>{fmtNum(s.price * 1e6)} {s.pairSymbol} / 1M</b></div>
      <div><span>FDV now → at grad</span><b>{fmtNum(s.fdv)} → {fmtNum(s.gradFdv)} {s.pairSymbol}</b></div>
      <div><span>Sold on curve</span><b>{fmtTokens(s.soldTokens)} / 800M</b></div>
      <div><span>Trade tax</span><b>{(s.taxBps / 100).toFixed(0)}%</b></div>
    </div>
    <p className="fine">Read from <a href={addr(s.curve)} target="_blank" rel="noreferrer">curve contract ↗</a> every 20s. Spot price excludes tax and price impact.{!s.fits && !s.complete ? " This curve does not match the standard V6 shape; the chart is approximate." : ""}</p>
  </div>;
}
