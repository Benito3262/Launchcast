import type { Address } from "viem";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function isZeroAddress(address: string): boolean {
  return address.toLowerCase() === ZERO_ADDRESS;
}

export function hasMatchingTokenCurveLinks(
  token: Address, curve: Address, curveToken: Address, tokenCurve: Address,
): boolean {
  return curveToken.toLowerCase() === token.toLowerCase()
    && tokenCurve.toLowerCase() === curve.toLowerCase();
}

export function latestLaunchRange(launchCount: bigint, requestedLimit: number) {
  if (launchCount < 0n) throw new RangeError("Launch count cannot be negative.");
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
    throw new RangeError("Launch limit must be a positive safe integer.");
  }
  const limit = BigInt(requestedLimit);
  return { first: launchCount > limit ? launchCount - limit : 0n, endExclusive: launchCount };
}

export type V6DiscoveryStatus =
  | "factory_reports_no_launches"
  | "sampled_records_validated"
  | "no_records_validated_with_read_errors"
  | "no_records_validated_in_sampled_window";

export function classifyV6DiscoveryStatus(
  launchCount: bigint, validatedRecords: number, readErrors: number,
): V6DiscoveryStatus {
  if (launchCount === 0n) return "factory_reports_no_launches";
  if (validatedRecords > 0) return "sampled_records_validated";
  if (readErrors > 0) return "no_records_validated_with_read_errors";
  return "no_records_validated_in_sampled_window";
}

const Q192 = 1n << 192n;
const ONE_18 = 10n ** 18n;

function assertDecimals(decimals: number, label: string): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new RangeError(`${label} decimals must be an integer from 0 to 36.`);
  }
}

export function pairPriceScaled1e18(
  rawNumerator: bigint, rawDenominator: bigint, tokenDecimals: number, pairDecimals: number,
): bigint {
  if (rawNumerator < 0n || rawDenominator <= 0n) throw new RangeError("Price ratio must be non-negative with a positive denominator.");
  assertDecimals(tokenDecimals, "Token");
  assertDecimals(pairDecimals, "Pair");
  return rawNumerator * (10n ** BigInt(tokenDecimals)) * ONE_18
    / (rawDenominator * (10n ** BigInt(pairDecimals)));
}

export function curvePriceScaled1e18(
  pairCost: bigint, tokenOut: bigint, tokenDecimals: number, pairDecimals: number,
): bigint {
  if (pairCost <= 0n || tokenOut <= 0n) throw new RangeError("Curve quote must have positive pair cost and token output.");
  return pairPriceScaled1e18(pairCost, tokenOut, tokenDecimals, pairDecimals);
}

export function v4PriceScaled1e18(
  sqrtPriceX96: bigint, tokenIsCurrency0: boolean, tokenDecimals: number, pairDecimals: number,
): bigint {
  if (sqrtPriceX96 <= 0n) throw new RangeError("Pool sqrt price must be positive.");
  const square = sqrtPriceX96 * sqrtPriceX96;
  return tokenIsCurrency0
    ? pairPriceScaled1e18(square, Q192, tokenDecimals, pairDecimals)
    : pairPriceScaled1e18(Q192, square, tokenDecimals, pairDecimals);
}

export function fdvPairScaled1e18(
  pricePairScaled1e18: bigint, totalSupplyBaseUnits: bigint, tokenDecimals: number,
): bigint {
  if (pricePairScaled1e18 < 0n || totalSupplyBaseUnits < 0n) throw new RangeError("FDV inputs cannot be negative.");
  assertDecimals(tokenDecimals, "Token");
  return pricePairScaled1e18 * totalSupplyBaseUnits / (10n ** BigInt(tokenDecimals));
}

export function sqrtPriceFromPoolStateWord(word: string): bigint {
  if (!/^0x[0-9a-fA-F]{64}$/.test(word)) throw new TypeError("Pool state word must be a 32-byte hex value.");
  return BigInt(word) & ((1n << 160n) - 1n);
}
