import test from "node:test";
import assert from "node:assert/strict";
import { assertDistinctArchiveProviders } from "./secondary-archive.js";

test("requires a configured primary and secondary archive provider", () => {
  assert.throws(() => assertDistinctArchiveProviders(undefined, "https://archive-two.example/rpc"), /ARCHIVE_RPC_URL/);
  assert.throws(() => assertDistinctArchiveProviders("https://archive-one.example/rpc", undefined), /SECONDARY_ARCHIVE_RPC_URL/);
});

test("rejects two URLs on the same provider host", () => {
  assert.throws(
    () => assertDistinctArchiveProviders("https://archive-one.example/rpc", "https://archive-one.example/other-path"),
    /different provider hosts/,
  );
});

test("accepts distinct archive provider hosts", () => {
  assert.deepEqual(
    assertDistinctArchiveProviders("https://archive-one.example/rpc", "https://archive-two.example/rpc"),
    { primaryHost: "archive-one.example", secondaryHost: "archive-two.example" },
  );
});

test("rejects malformed provider URLs", () => {
  assert.throws(() => assertDistinctArchiveProviders("not-a-url", "https://archive-two.example/rpc"), /valid absolute URLs/);
});
