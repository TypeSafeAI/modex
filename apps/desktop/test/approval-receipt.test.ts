import { test } from "node:test";
import assert from "node:assert/strict";
import { askedBecause, receiptVia } from "../src/shared/approval-receipt.js";
import type { ApprovalReceipt } from "../src/shared/types.js";

const receipt = (over: Partial<ApprovalReceipt> = {}): ApprovalReceipt => ({ source: "rule", ruleId: "r1", when: "run the test suite", decision: "ask", via: "jev", p: 0.94, ms: 410, ...over });

test("receipt rows name how the rule applied: an exact match, or Jev's probability", () => {
  assert.equal(receiptVia(receipt({ via: "match", p: 1 })), "exact match");
  assert.equal(receiptVia(receipt({ p: 0.9 })), "Jev 0.90");
  assert.equal(receiptVia(receipt({ p: undefined })), "Jev");
});

test("an asked card says which rule, or which safety check, sent it to a human", () => {
  assert.equal(askedBecause(receipt({ when: "touch CI config" })), 'Asked because: rule "touch CI config"');
  assert.equal(askedBecause(receipt({ downgraded: "destructive", destructive: 0.71 })), 'Asked because: looks destructive (Jev 0.71); rule "run the test suite" would have allowed it');
  assert.equal(askedBecause(receipt({ downgraded: "escalation", via: "match" })), 'Asked because: needs more sandbox access; rule "run the test suite" would have allowed it');
  assert.equal(askedBecause(receipt({ when: "touch CI config", via: "match", downgraded: "jev-unavailable" })), 'Asked because: rule "touch CI config" · Jev unavailable');
});
