/**
 * A V6 curve is graduated only when the matching V4 pool was initialized,
 * the V6 locker added a positive liquidity position, and that position is
 * still active at the observation block. `curve.complete()` alone is not
 * sufficient evidence.
 */
export function determineGraduationOutcome(
  curveComplete: boolean,
  poolInitialized: boolean,
  lockerLiquidityAdded: bigint,
  activeLiquidity: bigint,
): boolean {
  if (poolInitialized && !curveComplete) {
    throw new Error("A V4 pool cannot be treated as graduated while its V6 curve is incomplete.");
  }
  if (!poolInitialized && (lockerLiquidityAdded !== 0n || activeLiquidity !== 0n)) {
    throw new Error("V4 liquidity exists without the matching pool initialization event.");
  }
  if (poolInitialized && lockerLiquidityAdded <= 0n) {
    throw new Error("V4 pool initialized without a positive liquidity position from the V6 locker.");
  }
  if (poolInitialized && activeLiquidity <= 0n) {
    throw new Error("V6 locker position is not active at the observation block.");
  }
  return poolInitialized && lockerLiquidityAdded > 0n && activeLiquidity > 0n;
}
