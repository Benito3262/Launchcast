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

test("selects the latest V4 swap or initialization event at or before th¶»§q«^