import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_ROUTING } from "../src/shared/types.js";
import { codexQuota, claudeQuota, quotaState, type QuotaSnapshot } from "../src/main/engine/routing/quota.js";

const now = 1_800_000_000_000;
const snap = (remainingPercent: number): QuotaSnapshot => ({ at: now, windows: [{ key: "primary", remainingPercent, resetsAt: now + 60_000 }] });
const state = (s: QuotaSnapshot | undefined) => quotaState(s, DEFAULT_ROUTING, "gpt-6-sol", now);

test("quota thresholds include their boundary and retain reset information", () => {
  assert.equal(state(snap(21)).state, "healthy");
  assert.equal(state(snap(20)).state, "low");
  assert.match(state(snap(20)).reason, /20%.*reset/i);
  assert.equal(state(snap(0)).state, "exhausted");
  assert.equal(quotaState(snap(25), { ...DEFAULT_ROUTING, low_quota_percent: 30 }, "", now).state, "low");
});

test("unreadable, stale, future and expired quota is unknown, never full credit", () => {
  for (const s of [undefined, { at: now, windows: [] }, { ...snap(90), at: now - 300_001 }, { ...snap(90), at: now + 1000 },
    { at: now, windows: [{ key: "past", remainingPercent: 100, resetsAt: now }] },
    { at: now, windows: [{ key: "bad", remainingPercent: Number.NaN }] }]) {
    assert.equal(state(s).state, "unknown");
  }
});

test("included allowance is independent of purchased credits; paid-only balances conserve or stop", () => {
  assert.equal(state({ ...snap(80), credits: { hasCredits: false, unlimited: false, balance: 0 } }).state, "healthy");
  assert.equal(state({ ...snap(0), credits: { hasCredits: true, unlimited: false, balance: 100 } }).state, "low");
  assert.equal(state({ at: now, windows: [], credits: { hasCredits: true, unlimited: false, balance: 10 } }).state, "low");
  assert.equal(state({ at: now, windows: [], credits: { hasCredits: true, unlimited: false, balance: 11 } }).state, "healthy");
  assert.equal(state({ at: now, windows: [], includedUnavailable: true, credits: { hasCredits: false, unlimited: false, balance: 0 } }).state, "exhausted");
  assert.equal(state({ at: now, windows: [], credits: { hasCredits: true, unlimited: false } }).state, "unknown");
  assert.equal(state({ at: now, windows: [], credits: { hasCredits: true, unlimited: true } }).state, "healthy");
  assert.equal(state({ ...snap(90), blocked: true }).state, "exhausted");
});

test("model-scoped windows do not exhaust another model", () => {
  const s = { at: now, windows: [{ key: "model", model: "gpt-6-astra", remainingPercent: 0 }] };
  assert.equal(state(s).state, "unknown");
  assert.equal(quotaState(s, DEFAULT_ROUTING, "gpt-6-astra", now).state, "exhausted");
});

test("Codex normalization validates numeric data, distinguishes buckets and preserves credits", () => {
  const window = { usedPercent: 85, resetsAt: (now + 60_000) / 1000 };
  const s = codexQuota({ rateLimits: { primary: window, credits: { hasCredits: true, unlimited: false, balance: "9.5" } },
    rateLimitsByLimitId: { extra: { normalModelSlug: "gpt-6-astra", primary: { usedPercent: 100 } } } }, now);
  assert.equal(state(s).state, "low");
  assert.equal(s.credits?.balance, 9.5);
  assert.equal(s.windows.find(w => w.model)?.model, "gpt-6-astra");
  for (const usedPercent of [null, "85", -1, 101, Number.NaN]) {
    assert.equal(state(codexQuota({ rateLimits: { primary: { usedPercent } } }, now)).state, "unknown");
  }
  assert.equal(state(codexQuota({ rateLimits: { credits: { hasCredits: true, balance: "" } } }, now)).state, "unknown");
});

test("Claude events preserve warning/rejection and utilization without inventing balances", () => {
  assert.equal(state(claudeQuota({ status: "allowed", utilization: 0.85, resetsAt: (now + 60_000) / 1000 }, now)).state, "low");
  assert.equal(state(claudeQuota({ status: "allowed" }, now)).state, "unknown");
  assert.equal(state(claudeQuota({ status: "allowed_warning" }, now)).state, "low");
  assert.equal(state(claudeQuota({ status: "rejected", resetsAt: (now + 60_000) / 1000 }, now)).state, "exhausted");
  assert.equal(state(claudeQuota({ status: "allowed", utilization: 85 }, now)).state, "unknown");
});

test("a missing included-quota reading plus empty purchased credits is unknown, not proof of exhaustion", () => {
  const s = codexQuota({ rateLimits: { primary: null, secondary: null, credits: { hasCredits: false, unlimited: false, balance: "0" } } }, now);
  assert.equal(state(s).state, "unknown");
  assert.equal(state(codexQuota({ ordinaryUsageAllowed: false, rateLimits: { credits: { hasCredits: false, balance: "0" } } }, now)).state, "exhausted");
});

test("affirmative paid-credit availability with an unknown amount permits conservation after included exhaustion", () => {
  for (const balance of [undefined, null, "unreadable"]) {
    const snapshot = codexQuota({ rateLimits: { primary: { usedPercent: 100 }, credits: { hasCredits: true, unlimited: false, balance } } }, now);
    assert.equal(state(snapshot).state, "low");
    assert.equal(snapshot.credits?.balance, undefined);
  }
});
