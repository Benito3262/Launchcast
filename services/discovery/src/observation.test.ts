import test from "node:test";
import assert from "node:assert/strict";
import { evaluateFdvEligibility, findBlockAtOrBeforeTimestamp, selectLatestV4PriceEvent } from "./observation.js";

function reader(timestamps: bigint[]) {
  return async (blockNumber: bigint) => timestamps[Number(blockNumber)]!;
}

test("selects the last block at or before a target timestamp", async () => {
  const timestamps = [100n, 101n, 102n, 102n, 104n, 106n];
  const result = await findBlockAtOrBeforeTimestamp(5n, 102n, reader(timestamps));
  assert.deepEqual(result, { blockNumber: 3n, timestamp: 102n });
});

test("selects the previous block when no block has the exact target second", async () => {
  const timestamps = [100n, 101n, 102n, 102n, 104n, 106n];
  const result = await findBlockAtOrBeforeTimestamp(5n, 103n, reader(timestamps));
  assert.deepEqual(result, { blockNumber: 3n, timestamp: 102n });
});

test("rejects targets outside the available chain time range", async () => {
  const timestamps = [100n, 101n, 102n];
  await assert.rejects(findBlockAtOrBeforeTimestamp(2n, 99n, reader(timestamps)), RangeError);
  await assert.rejects(findBlockAtOrBeforeTimestamp(2n, 103n, reader(timestamps)), RangeError);
});

test("handles a chain with only the genesis block", async () => {
  const result = await findBlockAtOrBeforeTimestamp(0n, 100n, reader([100n]));
  assert.deepEqual(result, { blockNumber: 0n, timestamp: 100n });
});

test("selects the latest V4 swap or initialization event at or before the target block", () => {
  const events = [
    { source: "initialize" as const, blockNumber: 10n, logIndex: 2, sqrtPriceX96: 100n },
    { source: "swap" as const, blockNumber: 12n, logIndex: 3, sqrtPriceX96: 120n },
    { source: "swap" as const, blockNumber: 12n, logIndex: 8, sqrtPriceX96: 125n },
    { source: "swap" as const, blockNumber: 14n, logIndex: 1, sqrtPriceX96: 140n },
  ];
  assert.deepEqual(selectLatestV4PriceEvent(events, 12n), events[2]);
  assert.deepEqual(selectLatestV4PriceEvent(events, 11n), events[0]);
  assert.equal(selectLatestV4PriceEvent(events, 9n), null);
});


test("FDV eligibility requires historical supply and a fresh positive price", () => {
  assert.deepEqual(evaluateFdvEligibility({
    pricePairScaled1e18: 2n, totalSupplyAtObservation: 100n,
    priceEventAgeSeconds: 30n, maxStalenessSeconds: 60n,
  }), { eligible: true, reasons: [] });
});

test("FDV eligibility rejects missing historical supply instead of substituting current supply", () => {
  assert.deepEqual(evaluateFdvEligibility({
    pricePairScaled1e18: 2n, totalSupplyAtObservation: null,
    priceEventAgeSeconds: 30n, maxStalenessSeconds: 60n,
  }), { eligible: false, reasons: ["historical_supply_unavailable"] });
});

test("FDV eligibility rejects stale, future-dated, and non-positive observations", () => {
  assert.deepEqual(evaluateFdvEligibility({
    pricePairScaled1e18: 0n, totalSupplyAtObservation: 0n,
    priceEventAgeSeconds: 61n, maxStalenessSeconds: 60n,
  }), { eligible: false, reasons: ["non_positive_price", "non_positive_historical_supply", "stale_price_event"] });
  assert.deepEqual(evaluateFdvEligibility({
    pricePairScaled1e18: 2n, totalSupplyAtObservation: 100n,
    priceEventAgeSeconds: -1n, maxStalenessSeconds: 60n,
  }), { eligible: false, reasons: ["price_event_after_observation"] });
});
