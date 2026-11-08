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
