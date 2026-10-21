import { test } from "node:test";
import assert from "node:assert/strict";
import { prKeyId, scopeOf, type CodeReviewReply, type CodeReviewRequest, type PrKey } from "../src/shared/code-review.js";
import { Reader } from "../src/renderer/code-review/reader.js";
import { back, canBack, canForward, closeChanges, current, DEFAULT_VIEW, fitSplit, fitTree, forward, panesFor, showTab, SPLIT, toggleSplit, visit, type History } from "../src/renderer/code-review/navigation.js";
import { isPinned, loadPins, PINS_KEY, togglePin } from "../src/renderer/code-review/pins.js";
import { CODE_REVIEW_SWITCH, codeReviewEnabled } from "../src/renderer/code-review/feature.js";
import { loadLayout, saveLayout } from "../src/shared/layout.js";
import { ACCOUNT_A, ACCOUNT_B, FIELD_GUIDE, key, LENDING, locator, R1, R4 } from "./fixtures/code-review.js";

// CR-3 (#322): the renderer half of the read path, and the workspace's navigation and geometry.

const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const NOW = "2026-10-18T20:41:00Z";

/** A main that answers each request when the test says so, and records what it was sent. */
function fakeMain() {
  const sent: CodeReviewRequest[] = [];
  const waiting = new Map<string, ReturnType<typeof deferred<CodeReviewReply | null>>>();
  const send = (request: CodeReviewRequest) => {
    sent.push(request);
    if (request.op === "cancel") return Promise.resolve(null);
    const d = deferred<CodeReviewReply | null>();
    waiting.set(request.requestId, d);
    return d.promise;
  };
  /** Answer a request with its own scope (what main does), or with `scope` to fake a wrong one. */
  const answer = (requestId: string, result: unknown, scope?: CodeReviewReply["scope"]) => {
    const request = sent.find(r => r.requestId === requestId && r.op !== "cancel")!;
    waiting.get(requestId)!.resolve({ requestId, op: request.op as CodeReviewReply["op"], scope: scope ?? scopeOf(request, ACCOUNT_A.id), result } as CodeReviewReply);
  };
  return { sent, send, answer, waiting };
}

test("a reader applies the reply to what it asked, and a newer read in the same slot supersedes and cancels the older", async () => {
  const main = fakeMain();
  const reader = new Reader(main.send, () => NOW, "t");
  const first = reader.read("inbox", { op: "inbox", query: "loan" }, ACCOUNT_A.id);
  const second = reader.read("inbox", { op: "inbox", query: "loan policy" }, ACCOUNT_A.id);
  assert.deepEqual(main.sent.map(r => [r.op, r.requestId]), [["inbox", "t-1"], ["cancel", "t-1"], ["inbox", "t-2"]]);
  main.answer("t-1", R1.inbox);
  main.answer("t-2", R1.inbox);
  assert.deepEqual(await first, { status: "superseded" });
  const applied = await second;
  assert.equal(applied.status, "applied");
  assert.equal(applied.status === "applied" && applied.result.state, "ready");
  assert.equal(reader.pending("inbox"), false);
});

test("identical PR numbers in two repositories, or one key under two accounts, never take each other's reply", async () => {
  const main = fakeMain();
  const reader = new Reader(main.send, () => NOW, "t");
  const lending = key(ACCOUNT_A, LENDING, 73), fieldGuide = key(ACCOUNT_A, FIELD_GUIDE, 73);
  assert.notEqual(prKeyId(lending), prKeyId(fieldGuide));
  const a = reader.read(`overview:${prKeyId(lending)}`, { op: "overview", key: lending }, ACCOUNT_A.id);
  const b = reader.read(`overview:${prKeyId(fieldGuide)}`, { op: "overview", key: fieldGuide }, ACCOUNT_A.id);
  // Main answers the lending request with the field-guide PR's scope: the reply is not this request's.
  main.answer("t-1", { state: "ready", value: R4.overview, fetchedAt: NOW }, scopeOf({ op: "overview", requestId: "t-1", key: fieldGuide }, ACCOUNT_A.id));
  main.answer("t-2", { state: "ready", value: R4.overview, fetchedAt: NOW });
  assert.deepEqual(await a, { status: "mismatch" });
  assert.equal((await b).status, "applied");
  const other = reader.read("overview:b", { op: "overview", key: key(ACCOUNT_B, LENDING, 73) }, ACCOUNT_B.id);
  main.answer("t-3", { state: "ready", value: R4.overview, fetchedAt: NOW }, { account: ACCOUNT_A.id, key: lending, revision: null });
  assert.deepEqual(await other, { status: "mismatch" });
});

test("a read before the account is known is never applied, and cancelAll drops every pending read", async () => {
  const main = fakeMain();
  const reader = new Reader(main.send, () => NOW, "t");
  const early = reader.read("inbox", { op: "inbox", query: "" }, null);
  main.answer("t-1", R1.inbox);
  assert.deepEqual(await early, { status: "mismatch" });
  const pending = reader.read("overview:x", { op: "overview", key: key(ACCOUNT_A, LENDING, 73) }, ACCOUNT_A.id);
  assert.equal(reader.pending("overview:x"), true);
  reader.cancelAll();
  assert.deepEqual(main.sent.at(-1), { op: "cancel", requestId: "t-2" });
  main.answer("t-2", { state: "ready", value: R1.overview, fetchedAt: NOW });
  assert.deepEqual(await pending, { status: "superseded" });
  assert.equal(reader.pending("overview:x"), false);
});

test("a rejected invoke is an unavailable read, and connection is matched by request id alone", async () => {
  const main = fakeMain();
  const reader = new Reader(main.send, () => NOW, "t");
  const failing = reader.read("inbox", { op: "inbox", query: "" }, ACCOUNT_A.id);
  main.waiting.get("t-1")!.reject(new Error("No handler registered for 'code-review:read'"));
  assert.deepEqual(await failing, { status: "applied", result: { state: "unavailable", reason: "failed", fetchedAt: NOW }, scope: { account: ACCOUNT_A.id, key: null, revision: null } });
  const connection = reader.read("connection", { op: "connection" }, null);
  main.answer("t-2", R1.connection, { account: ACCOUNT_A.id, key: null, revision: null });
  assert.equal((await connection).status, "applied");
  const empty = reader.read("inbox", { op: "inbox", query: "" }, ACCOUNT_A.id);
  main.waiting.get("t-3")!.resolve(null);
  assert.equal((await empty).status, "applied", "a null reply to a read is a failed read, not silence");
});

test("history moves between PRs without duplicating the current entry, and a new visit drops the forward entries", () => {
  let h: History = { entries: [], index: -1 };
  assert.equal(current(h), null);
  h = visit(h, "a"); h = visit(h, "a"); h = visit(h, "b"); h = visit(h, "c");
  assert.deepEqual(h, { entries: ["a", "b", "c"], index: 2 });
  h = back(back(h));
  assert.equal(current(h), "a");
  assert.equal(canBack(h), false);
  assert.equal(canForward(h), true);
  h = forward(h);
  assert.equal(current(h), "b");
  h = visit(h, null);
  assert.deepEqual(h, { entries: ["a", "b", null], index: 2 }, "closing the PR is a place too");
  for (let i = 0; i < 150; i++) h = visit(h, `p${i}`);
  assert.equal(h.entries.length, 100);
  assert.equal(current(h), "p149");
});

test("a PR's view switches tabs, closes Changes, and leaves or enters the split without losing the other pane", () => {
  assert.deepEqual(DEFAULT_VIEW, { mode: "overview", changes: true, focus: "overview" });
  const changes = showTab(DEFAULT_VIEW, "changes");
  assert.deepEqual(changes, { mode: "changes", changes: true, focus: "changes" });
  const split = toggleSplit(changes);
  assert.deepEqual(split, { mode: "split", changes: true, focus: "changes" });
  assert.deepEqual(showTab(split, "overview"), { mode: "split", changes: true, focus: "overview" }, "a tab in the split focuses its pane");
  assert.deepEqual(toggleSplit(showTab(split, "overview")), { mode: "overview", changes: true, focus: "overview" });
  assert.deepEqual(closeChanges(split), { mode: "overview", changes: false, focus: "overview" });
  assert.deepEqual(toggleSplit(closeChanges(split)), { mode: "split", changes: true, focus: "changes" }, "the split reopens Changes");
  assert.deepEqual(showTab(closeChanges(split), "changes"), { mode: "changes", changes: true, focus: "changes" });
});

test("the split collapses to its focused pane when the workspace is too narrow for both", () => {
  const split = { mode: "split", changes: true, focus: "changes" } as const;
  assert.deepEqual(panesFor(split, SPLIT.min), ["overview", "changes"]);
  assert.deepEqual(panesFor(split, SPLIT.min - 1), ["changes"]);
  assert.deepEqual(panesFor({ ...split, focus: "overview" }, 600), ["overview"]);
  assert.deepEqual(panesFor(DEFAULT_VIEW, 2000), ["overview"]);
  assert.deepEqual(panesFor(showTab(DEFAULT_VIEW, "changes"), 2000), ["changes"]);
});

test("restored pane widths are fitted to the room there is, never stranding a pane outside the window", () => {
  assert.equal(fitSplit(undefined, 1400), Math.round((1400 - 1) * SPLIT.ratio), "R4's proportion by default");
  assert.equal(fitSplit(659, 1400), 659);
  assert.equal(fitSplit(5000, 1400), 1400 - 1 - SPLIT.changesMin);
  assert.equal(fitSplit(10, 1400), SPLIT.overviewMin);
  assert.equal(fitTree(undefined, 760), SPLIT.tree);
  assert.equal(fitTree(290, 760), 290);
  assert.equal(fitTree(700, 760), 760 - 1 - SPLIT.diffMin);
  assert.equal(fitTree(5, 760), SPLIT.treeMin);
  assert.equal(fitTree(undefined, SPLIT.diffMin + 1 + SPLIT.treeMin), SPLIT.treeMin);
  assert.equal(fitTree(290, SPLIT.diffMin + SPLIT.treeMin), null, "without room for both minimums the tree folds away");
});

test("pins are local, per account, validated on load and capped", () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  const lending = { key: key(ACCOUNT_A, LENDING, 73), locator: locator(LENDING, 73), title: "Lending 73" };
  assert.deepEqual(loadPins(storage, ACCOUNT_A.id), []);
  let pins = togglePin(storage, ACCOUNT_A.id, lending);
  assert.equal(isPinned(pins, lending.key), true);
  assert.deepEqual(loadPins(storage, ACCOUNT_B.id), [], "another account sees none of them");
  pins = togglePin(storage, ACCOUNT_A.id, lending);
  assert.equal(isPinned(pins, lending.key), false);
  store.set(PINS_KEY, JSON.stringify({ [ACCOUNT_A.id]: [lending, { ...lending, key: { ...lending.key, account: ACCOUNT_B.id } }, { key: { host: "evil.example" }, locator: lending.locator, title: "x" }, "junk"] }));
  assert.deepEqual(loadPins(storage, ACCOUNT_A.id), [lending], "a pin under another account's key or a malformed one is dropped");
  store.set(PINS_KEY, "{not json");
  assert.deepEqual(loadPins(storage, ACCOUNT_A.id), []);
  for (let n = 1; n <= 60; n++) togglePin(storage, ACCOUNT_A.id, { ...lending, key: key(ACCOUNT_A, LENDING, n), locator: locator(LENDING, n) });
  assert.equal(loadPins(storage, ACCOUNT_A.id).length, 50);
});

test("the destination is on in development and hidden in a built app unless its switch is set", () => {
  const storage = (value: string | null) => ({ getItem: (k: string) => k === CODE_REVIEW_SWITCH ? value : null });
  assert.equal(codeReviewEnabled(storage(null), true), true);
  assert.equal(codeReviewEnabled(storage(null), false), false);
  assert.equal(codeReviewEnabled(storage("on"), false), true);
  assert.equal(codeReviewEnabled(storage("yes"), false), false);
  assert.equal(codeReviewEnabled({ getItem: () => { throw new Error("blocked"); } }, false), false);
});

test("the workspace's pane widths persist with the layout, and invalid saved values fall back", () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  saveLayout(storage, { ...loadLayout(storage), codeReviewSplit: 659, codeReviewTree: 290 });
  assert.equal(loadLayout(storage).codeReviewSplit, 659);
  assert.equal(loadLayout(storage).codeReviewTree, 290);
  store.set("modex.layout", JSON.stringify({ v: 1, codeReviewSplit: "wide", codeReviewTree: -4 }));
  assert.equal(loadLayout(storage).codeReviewSplit, undefined);
  assert.equal(loadLayout(storage).codeReviewTree, undefined);
});

// Keys built for the fixture repos keep their account: a key is never re-homed by the view.
test("fixture keys used here carry the account they were read under", () => {
  const k: PrKey = key(ACCOUNT_B, FIELD_GUIDE, 73);
  assert.equal(k.account, ACCOUNT_B.id);
});
