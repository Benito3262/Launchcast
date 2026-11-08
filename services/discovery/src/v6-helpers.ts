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
