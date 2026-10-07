import { test } from "node:test";
import assert from "node:assert/strict";
import {
  filterEvents,
  summarize,
  exportCsv,
  costLabel,
  type UsageEvent,
} from "../src/renderer/usage/ledger.js";
import { sampleEvents } from "../src/renderer/usage/sample.js";
const event = (patch: Partial<UsageEvent> = {}): UsageEvent => ({
  id: "1",
  at: "2026-04-01T12:00:00Z",
  tool: "codex",
  model: "test",
  session: "s1",
  project: "/w",
  account: "unknown",
  kind: "main",
  input: 10,
  cached: 90,
  cacheWrite: 0,
  output: 20,
  reasoning: 5,
  cost: 0.01,
  uncachedCost: 0.02,
  ...patch,
});
test("usage filters include the complete UTC end date and combine tool and date constraints", () => {
  const rows = [
    event({ at: "2026-03-31T23:59:59Z" }),
    event(),
    event({ at: "2026-04-01T23:59:59Z" }),
    event({ at: "2026-04-02T00:00:00Z" }),
    event({ tool: "claude-code" }),
  ];
  assert.deepEqual(
    filterEvents(rows, {
      tool: "codex",
      since: "2026-04-01",
      until: "2026-04-01",
    }),
    rows.slice(1, 3),
  );
});
test("usage totals do not count reasoning twice or turn missing prices into free calls", () => {
  const total = summarize([
    event(),
    event({ id: "2", tool: "claude-code", cost: null, uncachedCost: null }),
  ]);
  assert.equal(total.tokens, 240);
  assert.equal(total.sessions, 2);
  assert.equal(total.cost, 0.01);
  assert.equal(total.saved, 0.01);
  assert.equal(total.unpriced, 1);
  assert.equal(total.hitRate, 90);
  assert.equal(total.activeDays, 1);
  assert.equal(summarize([]).hitRate, 0);
});
test("CSV preserves unknown prices and quotes hostile spreadsheet fields", () => {
  const csv = exportCsv([
    event({ model: '=HYPERLINK("example")', cost: null }),
  ]);
  assert.ok(csv.includes('"\'=HYPERLINK(""example"")"'));
  assert.ok(csv.includes(",unpriced"));
  assert.equal(csv.split("\r\n").length, 2);
});

test("cost labels distinguish unknown buckets, partial totals, and measured zero", () => {
  assert.equal(costLabel(summarize([event({ cost: null })])), "Unpriced");
  assert.equal(
    costLabel(summarize([event(), event({ cost: null })])),
    "$0.01 (partial)",
  );
  assert.equal(costLabel(summarize([event({ cost: 0 })])), "$0.00");
  assert.equal(costLabel(summarize([])), "$0.00");
});

test("demo activity is consistent across sessions, filters, and Copilot exports", () => {
  const copilot = filterEvents(sampleEvents, {
    tool: "github-copilot",
    since: "",
    until: "",
  });
  assert.ok(copilot.length > 1, "Copilot needs explorable sample sessions");
  assert.equal(costLabel(summarize(copilot)), "Unpriced");
  assert.ok(exportCsv(copilot).includes("github-copilot"));
  assert.equal(
    new Set(sampleEvents.map((row) => row.id)).size,
    sampleEvents.length,
  );
  const sessions = new Map<string, UsageEvent[]>();
  for (const row of sampleEvents) {
    const key = row.tool + ":" + row.session;
    sessions.set(key, [...(sessions.get(key) ?? []), row]);
    assert.ok(row.reasoning <= row.output, "Reasoning is part of output");
    assert.ok(
      row.input >= 0 &&
        row.cached >= 0 &&
        row.cacheWrite >= 0 &&
        row.output >= 0,
    );
    if (row.cost !== null)
      assert.ok(row.uncachedCost !== null && row.uncachedCost >= row.cost);
  }
  for (const rows of sessions.values()) {
    assert.equal(new Set(rows.map((row) => row.project)).size, 1);
    assert.equal(new Set(rows.map((row) => row.account)).size, 1);
  }
  const monthly = [
    ...new Set(sampleEvents.map((row) => row.at.slice(0, 7))),
  ].map((month) =>
    summarize(sampleEvents.filter((row) => row.at.startsWith(month))),
  );
  assert.equal(
    monthly.reduce((sum, total) => sum + total.tokens, 0),
    summarize(sampleEvents).tokens,
  );
  assert.ok(
    summarize(sampleEvents).unpriced > copilot.length,
    "Show gaps beyond one provider",
  );
});
