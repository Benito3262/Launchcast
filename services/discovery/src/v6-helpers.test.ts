import test from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import { classifyV6DiscoveryStatus, curvePriceScaled1e18, fdvPairScaled1e18, hasMatchingTokenCurveLinks, isZeroAddress, latestLaunchRange, pairPriceScaled1e18, sqrtPriceFromPoolStateWord, v4PriceScaled1e18 } from "./v6-helpers.js";

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

test("does not confuse empty samples with a factory reporting zero launches", () => {
  assert.equal(classifyV6DiscoveryStatus(0n, 0, 0), "factory_reports_no_launches");
  assert.equal(classifyV6DiscoveryStatus(20n, 0, 3), "no_records_validated_with_read_errors");
  assert.equal(classifyV6DiscoveryStatus(20n, 0, 0), "no_records_validated_in_sampled_window");
  assert.equal(classifyV6DiscoveryStatus(20n, 2, 1), "sampled_records_validated");
});

test("normalizes pair price using token and quote-asset decimals", () => {
  assert.equal(pairPriceScaled1e18(1n, 1n, 18, 18), 10n ** 18n);
  assert.equal(pairPriceScaled1e18(1n, 2n, 18, 18), 5n * 10n ** 17n);
  assert.equal(pairPriceScaled1e18(1n, 1n, 18, 6), 10n ** 30n);
});

test("calculates curve and V4 prices with the correct currency orientation", () => {
  assert.equal(curvePriceScaled1e18(1n, 2n, 18, 18), 5n * 10n ** 17n);
  const q96 = 1n << 96n;
  assert.equal(v4PriceScaled1e18(q96, true, 18, 18), 10n ** 18n);
  assert.equal(v4PriceScaled1e18(q96 * 2n, true, 18, 18), 4n * 10n ** 18n);
  assert.equal(v4PriceScaled1e18(q96 * 2n, false, 18, 18), 25n * 10n ** 16n);
});

test("calculates fully diluted valuation in quote-asset units", () => {
  assert.equal(fdvPairScaled1e18(10n ** 17n, 10n ** 27n, 18), 10n ** 26n);
});

test("extracts the low 160-bit sqrt price from a V4 state word", () => {
  const sqrt = 123456789n;
  const highBits = 0xfeedn << 160n;
  const word = "0x" + (highBits | sqrt).toString(16).padStart(64, "0");
  assert.equal(sqrtPriceFromPoolStateWord(word), sqrt);
  assert.throws(() => sqrtPriceFromPoolStateWord("0x1234"), TypeError);
});
