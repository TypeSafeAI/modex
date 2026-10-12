import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeCall, codexCall, UsageMeter, withUsage } from "../src/main/engine/backends/usage.js";

test("UsageMeter keeps the first call, sizes the context from the last, and counts each id once", () => {
  const meter = new UsageMeter();
  assert.equal(meter.usage(), undefined, "no call, no usage");
  meter.call({ cacheRead: 40_000, cacheWrite: 1_000, uncached: 5 }, "msg_1");
  meter.call({ cacheRead: 40_000, cacheWrite: 1_000, uncached: 5 }, "msg_1");
  meter.call({ cacheRead: 41_000, cacheWrite: 2_000, uncached: 3 }, "msg_2");
  meter.addOutput(700);
  meter.addOutput(300);
  assert.deepEqual(meter.usage(), { first: { cacheRead: 40_000, cacheWrite: 1_000, uncached: 5 }, contextTokens: 43_003, outputTokens: 1_000, calls: 2 });
});

test("calls without an id always count; unusable output values are ignored", () => {
  const meter = new UsageMeter();
  meter.call({ cacheRead: 0, cacheWrite: 0, uncached: 10 });
  meter.call({ cacheRead: 0, cacheWrite: 0, uncached: 10 });
  meter.addOutput(Number.NaN);
  meter.addOutput(-4);
  meter.addOutput("12");
  assert.deepEqual(meter.usage(), { first: { cacheRead: 0, cacheWrite: 0, uncached: 10 }, contextTokens: 10, calls: 2 });
});

test("Claude and Codex usage shapes map to the same split", () => {
  assert.deepEqual(claudeCall({ input_tokens: 2, cache_creation_input_tokens: 2293, cache_read_input_tokens: 371735 }), { cacheRead: 371735, cacheWrite: 2293, uncached: 2 });
  assert.deepEqual(claudeCall({}), { cacheRead: 0, cacheWrite: 0, uncached: 0 });
  assert.deepEqual(codexCall({ inputTokens: 50_000, cachedInputTokens: 45_000, cacheWriteInputTokens: 1_000 }), { cacheRead: 45_000, cacheWrite: 1_000, uncached: 4_000 });
  assert.deepEqual(codexCall({ inputTokens: 10, cachedInputTokens: 20 }), { cacheRead: 20, cacheWrite: 0, uncached: 0 }, "never negative");
});

test("withUsage attaches usage only when a call was seen", () => {
  const meter = new UsageMeter();
  assert.deepEqual(withUsage({ status: "completed" }, meter), { status: "completed" });
  meter.call({ cacheRead: 1, cacheWrite: 2, uncached: 3 });
  assert.deepEqual(withUsage({ status: "interrupted" }, meter), { status: "interrupted", usage: { first: { cacheRead: 1, cacheWrite: 2, uncached: 3 }, contextTokens: 6, calls: 1 } });
});
