import assert from "node:assert/strict";
import { test } from "node:test";
import { migrateRouting, Store } from "../src/main/engine/store.js";
import { tmpdir } from "./helpers.js";

test("existing installations gain automatic conservation and configurable validated thresholds", () => {
  const defaults = migrateRouting({});
  assert.deepEqual([defaults.conserve_credits, defaults.low_quota_percent, defaults.low_credit_balance], [true, 20, 10]);
  for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, "20", null]) {
    const r = migrateRouting({ low_quota_percent: value, low_credit_balance: value });
    assert.deepEqual([r.low_quota_percent, r.low_credit_balance], [20, 10]);
  }
  assert.equal(migrateRouting({ low_quota_percent: 101 }).low_quota_percent, 20);
  const home = tmpdir(), store = new Store(home);
  store.updateSettings({ routing: { ...defaults, conserve_credits: false, low_quota_percent: 25, low_credit_balance: 5 } });
  const saved = new Store(home).settings.routing;
  assert.deepEqual([saved.conserve_credits, saved.low_quota_percent, saved.low_credit_balance], [false, 25, 5]);
});
