import { test } from "node:test";
import assert from "node:assert/strict";
import { answerFor, decide, jevRules, matchesRule, MAX_JEV_RULES, receiptFor, type GateContext } from "../src/main/engine/approvals/gate.js";
import { JevError, type JevRequest, type JevResponse, type JevTransport } from "../src/main/engine/routing/jev.js";
import type { ApprovalAction } from "../src/main/engine/backends/types.js";
import type { ApprovalRule } from "../src/shared/types.js";

const ROOT = "/repo/modex";
const npmTest: ApprovalAction = { backend: "claude", tool: "Bash", title: "$ npm test", cwd: ROOT, input: { command: "npm test" } };

let seq = 0;
const rule = (when: string, decision: ApprovalRule["decision"], extra: Partial<ApprovalRule> = {}): ApprovalRule => ({ id: `r${++seq}`, when, decision, enabled: true, ...extra });

function ctx(rules: ApprovalRule[], transport: JevTransport | null = null, over: Partial<GateContext> = {}): GateContext {
  return { rules, config: { enabled: true, threshold: 0.8, timeout_ms: 1000 }, project: { root: ROOT, name: "modex", branch: "main" }, mode: "agent", transport, model: "jev-latest", ...over };
}

/** A fake Jev: answers each rule question from `byWhen` (default 0) and `destructive` (default 0). */
function fakeJev(byWhen: Record<string, number>, destructive = 0) {
  const calls: JevRequest[] = [];
  const transport: JevTransport = async (req) => {
    calls.push(req);
    const answers: JevResponse["answers"] = { destructive: { type: "noul", noul: destructive } };
    for (const [id, q] of Object.entries(req.questions)) {
      if (id === "destructive") continue;
      const when = /When the agent wants to (.*)'\./.exec(q.instructions)![1]!;
      answers[id] = { type: "noul", noul: byWhen[when] ?? 0 };
    }
    return { answers };
  };
  return { transport, calls };
}

test("gate off, no action, or no rule for this project → ask without asking Jev", async () => {
  const { transport, calls } = fakeJev({ "run the tests": 1 });
  const r = [rule("run the tests", "allow")];
  assert.equal((await decide(npmTest, ctx(r, transport, { config: { enabled: false, threshold: 0.8, timeout_ms: 1000 } }))).decision, "ask");
  assert.equal((await decide(undefined, ctx(r, transport))).decision, "ask");
  assert.equal((await decide(npmTest, ctx([rule("run the tests", "allow", { project: "/elsewhere" })], transport))).decision, "ask");
  assert.equal((await decide(npmTest, ctx([rule("run the tests", "allow", { enabled: false })], transport))).decision, "ask");
  assert.equal(calls.length, 0);
});

test("precedence: never > ask > allow", async () => {
  const { transport } = fakeJev({ "run the tests": 0.95, "run npm": 0.9, "run anything": 0.85 });
  const allow = rule("run the tests", "allow");
  const askR = rule("run npm", "ask");
  const never = rule("run anything", "never");
  let d = await decide(npmTest, ctx([allow, askR, never], transport));
  assert.deepEqual([d.decision, d.rule?.id, d.source], ["never", never.id, "jev"]);
  d = await decide(npmTest, ctx([allow, askR], transport));
  assert.deepEqual([d.decision, d.rule?.id], ["ask", askR.id]);
  d = await decide(npmTest, ctx([allow], transport));
  assert.deepEqual([d.decision, d.rule?.id, d.p], ["allow", allow.id, 0.95]);
  assert.equal(answerFor(d), "yes");
});

test("threshold edge: 0.79 does not apply, 0.8 does", async () => {
  const r = rule("run the tests", "allow");
  assert.equal((await decide(npmTest, ctx([r], fakeJev({ "run the tests": 0.79 }).transport))).decision, "ask");
  assert.equal((await decide(npmTest, ctx([r], fakeJev({ "run the tests": 0.8 }).transport))).decision, "allow");
});

test("nothing applies → ask, with no rule and no receipt", async () => {
  const d = await decide(npmTest, ctx([rule("push to main", "never")], fakeJev({}).transport));
  assert.deepEqual([d.decision, d.source, d.rule], ["ask", "none", undefined]);
  assert.equal(answerFor(d), null);
  assert.equal(receiptFor(d), undefined);
});

test("destructive downgrade: an allow on something Jev finds destructive is asked", async () => {
  const r = rule("clean build output", "allow");
  const rm: ApprovalAction = { backend: "claude", tool: "Bash", title: "$ rm -rf dist", input: { command: "rm -rf dist" } };
  let d = await decide(rm, ctx([r], fakeJev({ "clean build output": 0.95 }, 0.71).transport));
  assert.deepEqual([d.decision, d.downgraded, d.destructive, d.rule?.id], ["ask", "destructive", 0.71, r.id]);
  assert.deepEqual(receiptFor(d), { source: "rule", ruleId: r.id, when: "clean build output", decision: "ask", via: "jev", p: 0.95, ms: d.ms, downgraded: "destructive" });
  d = await decide(rm, ctx([r], fakeJev({ "clean build output": 0.95 }, 0.49).transport));
  assert.equal(d.decision, "allow");
  // An exact-match allow is checked for destructiveness too when Jev is live.
  d = await decide(rm, ctx([rule("anything in bash", "allow", { match: "Bash: *" })], fakeJev({}, 0.9).transport));
  assert.deepEqual([d.decision, d.downgraded, d.source], ["ask", "destructive", "match"]);
  // A never is never downgraded.
  d = await decide(rm, ctx([rule("delete files", "never")], fakeJev({ "delete files": 0.9 }, 0.99).transport));
  assert.equal(d.decision, "never");
});

test("escalation downgrade: only a human widens the sandbox", async () => {
  const perm: ApprovalAction = { backend: "codex", tool: "permissions", title: "grant additional permissions", escalation: true };
  let d = await decide(perm, ctx([rule("perms", "allow", { match: "permissions: *" })]));
  assert.deepEqual([d.decision, d.downgraded], ["ask", "escalation"]);
  d = await decide(perm, ctx([rule("anything", "allow")], fakeJev({ anything: 1 }).transport));
  assert.deepEqual([d.decision, d.downgraded], ["ask", "escalation"]);
  d = await decide(perm, ctx([rule("perms", "never", { match: "permissions: *" })]));
  assert.equal(d.decision, "never");
});

test("deterministic match works with no transport", async () => {
  const allow = rule("run the tests", "allow", { match: "Bash: npm test*" });
  let d = await decide(npmTest, ctx([allow, rule("anything else", "allow")], null));
  assert.deepEqual([d.decision, d.source, d.p, d.rule?.id], ["allow", "match", 1, allow.id]);
  assert.equal(answerFor(d), "yes", "a rule never answers 'always'");
  const codex: ApprovalAction = { backend: "codex", tool: "command", title: "git push origin main" };
  d = await decide(codex, ctx([rule("push", "never", { match: "command: git push*" })], null));
  assert.deepEqual([d.decision, answerFor(d)], ["never", "no"]);
  // Tool must match exactly; glob is case-sensitive and anchored.
  assert.equal(matchesRule("bash: npm test*", npmTest), false);
  assert.equal(matchesRule("Bash: NPM test*", npmTest), false);
  assert.equal(matchesRule("Bash: npm", npmTest), false);
  assert.equal(matchesRule("Bash: $ npm test", npmTest), true);
  assert.equal(matchesRule("Bash: npm t?st", npmTest), false, "only * is a wildcard");
  assert.equal(matchesRule("Bash npm test", npmTest), false, "no tool separator");
});

test("Jev throws, times out, or answers badly → the deterministic result stands, else ask", async () => {
  const thrower: JevTransport = async () => { throw new JevError("nope", "network"); };
  const slow: JevTransport = (_req, signal) => new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
  const bad: JevTransport = async () => ({ answers: { destructive: { type: "noul", noul: 0 }, rule_0: { type: "choice", choice: "x", probabilities: {}, confidence: 1 } } });
  const badResponse: JevTransport = async () => { throw new JevError("unreadable", "bad_response"); };
  const matchAllow = rule("git status", "allow", { match: "command: git status" });
  const jevAllow = rule("look around", "allow");
  const status: ApprovalAction = { backend: "codex", tool: "command", title: "git status" };
  for (const t of [thrower, slow, bad, badResponse]) {
    const fast = { config: { enabled: true, threshold: 0.8, timeout_ms: 30 } };
    let d = await decide(status, ctx([matchAllow, jevAllow], t, fast));
    assert.deepEqual([d.decision, d.source, d.downgraded], ["allow", "match", "jev-unavailable"]);
    assert.ok(d.jevError);
    d = await decide(status, ctx([jevAllow], t, fast));
    assert.deepEqual([d.decision, d.source], ["ask", "none"]);
  }
});

test("12-rule cap: project-scoped first, then newest", async () => {
  const global = Array.from({ length: 14 }, (_, i) => rule(`global ${i}`, "allow"));
  const scoped = [rule("scoped a", "allow", { project: ROOT }), rule("scoped b", "allow", { project: ROOT })];
  const all = [scoped[0]!, ...global, scoped[1]!];
  const picked = jevRules(all);
  assert.equal(picked.length, MAX_JEV_RULES);
  assert.deepEqual(picked.slice(0, 2).map((r) => r.when), ["scoped b", "scoped a"]);
  assert.deepEqual(picked.slice(2).map((r) => r.when), ["global 13", "global 12", "global 11", "global 10", "global 9", "global 8", "global 7", "global 6", "global 5", "global 4"]);
  const { transport, calls } = fakeJev({ "global 0": 1 });
  const d = await decide(npmTest, ctx(all, transport));
  assert.equal(Object.keys(calls[0]!.questions).length, MAX_JEV_RULES + 1, "12 rules plus destructive");
  assert.equal(d.decision, "ask", "the oldest global rule was beyond the cap");
});

test("project scoping: a rule for another project never applies", async () => {
  const mine = rule("run the tests", "allow", { project: ROOT });
  const theirs = rule("run the tests", "never", { project: "/repo/other" });
  const d = await decide(npmTest, ctx([mine, theirs], fakeJev({ "run the tests": 0.9 }).transport));
  assert.deepEqual([d.decision, d.rule?.id], ["allow", mine.id]);
});

test("the Jev request carries the digest, one noul per rule, and destructive", async () => {
  const edit: ApprovalAction = { backend: "claude", tool: "Edit", title: "edit a.ts", input: { file_path: "a.ts", old_string: "SECRET_OLD", new_string: "SECRET_NEW" } };
  const { transport, calls } = fakeJev({});
  await decide(edit, ctx([rule("edit source files", "allow")], transport));
  const req = calls[0]!;
  assert.deepEqual(Object.keys(req.questions).sort(), ["destructive", "rule_0"]);
  assert.ok(Object.values(req.questions).every((q) => q.type === "noul"));
  assert.match(req.questions.rule_0!.instructions, /When the agent wants to edit source files/);
  assert.ok(!JSON.stringify(req).includes("SECRET_"), "file contents never reach Jev");
  assert.equal(req.model, "jev-latest");
});

test("abort while Jev is pending → the approval is answered 'no'", async () => {
  const ac = new AbortController();
  const hanging: JevTransport = (_req, signal) => new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
  const pending = decide(npmTest, ctx([rule("run the tests", "allow")], hanging, { config: { enabled: true, threshold: 0.8, timeout_ms: 10_000 } }), ac.signal);
  ac.abort();
  const d = await pending;
  assert.equal(d.aborted, true);
  assert.equal(answerFor(d), "no");
  const pre = new AbortController();
  pre.abort();
  assert.equal(answerFor(await decide(npmTest, ctx([rule("x", "allow", { match: "Bash: *" })]), pre.signal)), "no");
});
