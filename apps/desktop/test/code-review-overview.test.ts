import { test } from "node:test";
import assert from "node:assert/strict";
import { activityPages, externalDestination, stackOrder } from "../src/shared/code-review-overview.js";
import { R1, R2, NOW } from "./fixtures/code-review.js";
import type { PrActivity, ReadResult } from "../src/shared/code-review.js";
assert(R2.activity.state !== "unavailable");
assert(R1.stack.state !== "unavailable");
const activity = R2.activity.value;
const stackFixture = R1.stack.value;
const ready = (value: PrActivity[], next: string | null = null): Extract<ReadResult<PrActivity[]>, { state: "ready" }> => ({ state: "ready", value, fetchedAt: NOW, coverage: { loaded: value.length, total: null, complete: !next, next } });
test("activity pagination deduplicates provider identities and orders equal timestamps deterministically", () => {
  const review: PrActivity = { kind: "review", id: "review-1", at: NOW, actor: R1.overview.author, verdict: "approved", body: "ok", commit: null };
  const result = activityPages([ready([...activity, review], "p2"), ready([review])]);
  assert.equal(result.rows.filter(r => r.id === review.id).length, 1);
  assert.deepEqual(result.rows, activityPages([ready([review]), ready([...activity, review])]).rows);
  assert.equal(result.complete, true);
});
test("a failed remaining page keeps earlier activity and does not claim completeness", () => {
  const result = activityPages([ready(activity, "p2"), { state: "unavailable", reason: "offline", fetchedAt: NOW }]);
  assert.equal(result.rows.length, activity.length);
  assert.equal(result.complete, false);
  assert.equal(result.next, "p2");
});
test("preview destinations reject credentials, controls and executable protocols", () => {
  for (const url of ["javascript:alert(1)", "file:///tmp/x", "https://trusted.example@evil.example", "https://example.com/\nx"]) assert.equal(externalDestination(url), null);
  assert.equal(externalDestination("https://preview.example/path"), "https://preview.example/path");
});
test("stack duplicates and invalid positions never invent an order; hidden members keep their place", () => {
  const stack = structuredClone(stackFixture);
  assert.equal(stackOrder(stack), true);
  stack.members.push(stack.members[0]!);
  assert.equal(stackOrder(stack), false);
  assert.equal(stackOrder({ ...stackFixture, position: 100 }), false);
});
test("a stale first page cannot become complete when a fresh last page arrives", () => {
  const first: ReadResult<PrActivity[]> = { ...ready(activity.slice(0, 4), "p2"), state: "stale", reason: "offline" };
  assert.equal(activityPages([first, ready(activity.slice(4))]).complete, false);
});
test("transient refresh failure retains earlier evidence as stale but revoked reads discard it", async () => {
  const { retainRead } = await import("../src/shared/code-review-overview.js");
  const previous = ready(activity);
  const failed: ReadResult<PrActivity[]> = { state: "unavailable", reason: "offline", fetchedAt: NOW };
  const retained = retainRead(previous, failed);
  assert.equal(retained.state, "stale");
  assert.deepEqual(retained.value, activity);
  assert.equal(retainRead(previous, { ...failed, reason: "denied" }).state, "unavailable");
});
