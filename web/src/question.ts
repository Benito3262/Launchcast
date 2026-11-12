import { formatUnits } from "viem";

/** "Nov 13, 12:19 WAT" in the viewer's own time zone. */
export function deadline(ts: bigint | number) {
  const d = new Date(Number(ts) * 1000);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  const base = d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  let zone = d.toLocaleTimeString("en-US", { timeZoneName: "short" }).split(" ").pop() || "";
  if (zone === "GMT+1" && /^Africa\/(Lagos|Kinshasa|Luanda|Douala|Libreville|Malabo|Niamey|Porto-Novo|Bangui|Brazzaville|Ndjamena)$/.test(tz)) zone = "WAT";
  return `${base} ${zone}`.trim();
}

export function tokenLabel(name?: string | null, symbol?: string | null, fallback = "this token") {
  const n = (name || "").trim(), s = (symbol || "").trim();
  if (n && s && n.toLowerCase() !== s.toLowerCase()) return `${n} (${s})`;
  return n || s || fallback;
}

const compact = (v: bigint, decimals: number) => Number(formatUnits(v, decimals)).toLocaleString(undefined, { maximumSignificantDigits: 4 });

export function graduationQuestion(name: string | undefined, symbol: string | undefined, at: bigint | number) {
  return `Will ${tokenLabel(name, symbol)} graduate by ${deadline(at)}?`;
}

export function fdvQuestion(name: string | undefined, symbol: string | undefined, threshold: bigint, decimals: number, pairSymbol: string, at: bigint | number) {
  return `Will ${tokenLabel(name, symbol)} FDV be above ${compact(threshold, decimals)} ${pairSymbol} by ${deadline(at)}?`;
}
