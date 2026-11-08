import test from "node:test";
import assert from "node:assert/strict";
import { assertCompleteBlockCoverage, evaluateFdvEligibility, findBlockAtOrBeforeTimestamp, reconstructSupplyFromTransferEvents, selectLatestV4PriceEvent } from "./observation.js";

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


const zeroAddress = "0x0000000000000000000000000000000000000000";
const walletA = "0x0000000000000000000000000000000000000001";
const walletB = "0x0000000000000000000000000000000000000002";
function supplyEvent(from: string, to: string, value: bigint, blockNumber: bigint, logIndex: number) {
  return {
    from, to, value, blockNumber, logIndex,
    transactionHash: "0x" + "1".repeat(64),
    blockHash: "0x" + "2".repeat(64),
  };
}

test("reconstructs supply from mint and burn Transfer events, not wallet transfers", () => {
  const events = [
    supplyEvent(walletA, walletB, 25n, 11n, 3),
    supplyEvent(zeroAddress, walletA, 100n, 10n, 0),
    supplyEvent(walletB, zeroAddress, 5n, 12n, 1),
  ];
  assert.deepEqual(reconstructSupplyFromTransferEvents(events, 12n), {
    totalSupply: 95n, mintCount: 1, burnCount: 1, transferCount: 3,
  });
});

test("uses logIndex ordering within a block and excludes events after observation", () => {
  const events = [
    supplyEvent(walletA, zeroAddress, 100n, 20n, 2),
    supplyEvent(zeroAddress, walletA, 100n, 20n, 1),
    supplyEvent(zeroAddress, walletB, 50n, 21n, 0),
  ];
  assert.equal(reconstructSupplyFromTransferEvents(events, 20n).totalSupply, 0n);
});

test("rejects a reconstructed negative supply", () => {
  assert.throws(
    () => reconstructSupplyFromTransferEvents([supplyEvent(walletA, zeroAddress, 1n, 1n, 0)], 1n),
    /negative/,
  );
});

test("requires exact contiguous log-range coverage", () => {
  assert.doesNotThrow(() => assertCompleteBlockCoverage([
    { fromBlock: 10n, toBlock: 14n },
    { fromBlock: 15n, toBlock: 19n },
  ], 10n, 19n));
  assert.throws(() => assertCompleteBlockCoverage([
    { fromBlock: 10n, toBlock: 14n },
    { fromBlock: 16n, toBlock: 19n },
  ], 10n, 19n), /gap/);
  assert.throws(() => assertCompleteBlockCoverage([
    { fromBlock: 10n, toBlock: 15n },
    { fromBlock: 15n, toBlock: 19n },
  ], 10n, 19n), /overlap/);
});
