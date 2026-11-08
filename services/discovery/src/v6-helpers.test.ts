import test from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import { hasMatchingTokenCurveLinks, isZeroAddress, latestLaunchRange } from "./v6-helpers.js";

const token = "0x1111111111111111111111111111111111111111" as Address;
const curve = "0x2222222222222222222222222222222222222222" as Address;

test("zero address check is case-insensitive", () => {
  assert.equal(isZeroAddress("0x0000000000000000000000000000000000000000"), true);
  assert.equal(isZeroAddress(token), false);
});

test("requires both token/curve pointers to agree", () => {
  assert.equal(hasMatchingTokenCurveLinks(token, curve, token, curve), true);
  assert.equal(hasMatchingTokenCurveLinks(token, curve, curve, token), false);
  assert.equal(hasMatchingTokenCurveLinks(token, curve, token, token), false);
});

test("enumerates only the requested latest launch IDs", () => {
  assert.deepEqual(latestLaunchRange(5n, 12), { first: 0n, endExclusive: 5n });
  assert.deepEqual(latestLaunchRange(100n, 12), { first: 88n, endExclusive: 100n });
});

test("rejects invalid launch limits and negative counts", () => {
  assert.throws(() => latestLaunchRange(10n, 0), RangeError);
  assert.throws(() => latestLaunchRange(10n, 1.5), RangeError);
  assert.throws(() => latestLaunchRange(-1n, 2), RangeError);
});
