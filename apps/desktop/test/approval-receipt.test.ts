import { test } from "node:test";
import assert from "node:assert/strict";
import { answeredApproval, askedBecause, jevNotConsulted, receiptVia } from "../src/shared/approval-receipt.js";
import type { ApprovalReceipt, ThreadItem } from "../src/shared/types.js";

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
  assert.equal(askedBecause(receipt({ downgraded: "compound", via: "match" })), 'Asked because: the command chains several commands; rule "run the test suite" would have allowed it');
  assert.equal(askedBecause(receipt({ downgraded: "incomplete" })), 'Asked because: Jev could not see the whole command; rule "run the test suite" would have allowed it');
});

test("a receipt says when Jev was not consulted, next to any downgrade label; older receipts still read", () => {
  assert.equal(askedBecause(receipt({ when: "touch CI config", via: "match", jevNotConsulted: true })), 'Asked because: rule "touch CI config" · Jev not consulted');
  assert.equal(askedBecause(receipt({ via: "match", downgraded: "compound", jevNotConsulted: true })), 'Asked because: the command chains several commands; rule "run the test suite" would have allowed it · Jev not consulted');
  assert.equal(askedBecause(receipt({ via: "match", downgraded: "escalation", jevNotConsulted: true })), 'Asked because: needs more sandbox access; rule "run the test suite" would have allowed it · Jev not consulted');
  assert.equal(askedBecause(receipt({ when: "touch CI config", via: "match", downgraded: "jev-unavailable" })), 'Asked because: rule "touch CI config" · Jev not consulted');
  assert.equal(jevNotConsulted(receipt({ decision: "allow", via: "match", jevNotConsulted: true })), true);
  assert.equal(jevNotConsulted(receipt({ decision: "allow", via: "match", downgraded: "jev-unavailable" })), true, "a receipt written before the flag");
  assert.equal(jevNotConsulted(receipt({ decision: "allow" })), false);
});

test("an answered approval reads as one receipt line; a waiting one has none", () => {
  type Approval = Extract<ThreadItem, { kind: "approval" }>;
  const approval = (over: Partial<Approval> = {}): Approval => ({ id: "a", kind: "approval", question: "Allow?", at: "", ...over });
  assert.equal(answeredApproval(approval()), null);
  assert.deepEqual(answeredApproval(approval({ answer: "yes", answeredBy: "desktop" })), { text: "Approved", tone: "allowed", by: "by you" });
  assert.deepEqual(answeredApproval(approval({ answer: "yes", answeredBy: "desktop", delivery: "sent" })), { text: "Approved", tone: "allowed", by: "by you" });
  assert.deepEqual(answeredApproval(approval({ answer: "always", answeredBy: "desktop" })), { text: "Approved — always for this command", tone: "allowed", by: "by you" });
  assert.deepEqual(answeredApproval(approval({ answer: "no", answeredBy: "desktop" })), { text: "Denied", tone: "refused", by: "by you" });
  assert.deepEqual(answeredApproval(approval({ answer: "yes", answeredBy: "phone" })), { text: "Approved", tone: "allowed", by: null }, "the note under the row says where it was answered");
  assert.deepEqual(answeredApproval(approval({ answer: "yes" })), { text: "Approved", tone: "allowed", by: null }, "an answer saved before the field existed claims nobody");
  assert.deepEqual(answeredApproval(approval({ answer: "yes", delivery: "sending" })), { text: "Sending decision…", tone: "neutral", by: null });
  assert.deepEqual(answeredApproval(approval({ answer: "yes", delivery: "uncertain" })), { text: "Delivery uncertain — not resent", tone: "warn", by: null });
  assert.deepEqual(answeredApproval(approval({ answer: "no", withdrawn: "stopped" })), { text: "Not answered — the turn was stopped", tone: "neutral", by: null });
  assert.deepEqual(answeredApproval(approval({ answer: "no", withdrawn: "native" })), { text: "Withdrawn — the agent no longer needs an answer", tone: "neutral", by: null });
  assert.deepEqual(answeredApproval(approval({ answer: "no", withdrawn: "ended" })), { text: "Not answered — the turn ended first", tone: "neutral", by: null });
});
