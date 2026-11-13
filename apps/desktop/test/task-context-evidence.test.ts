import { test } from "node:test";
import assert from "node:assert/strict";
import * as tasks from "../src/shared/task-context.js";
import type { ThreadItem } from "../src/shared/types.js";
import path from "node:path";
import { Store } from "../src/main/engine/store.js";
import { EventJournal, replayItems } from "../src/main/engine/event-journal.js";
import { tmpdir } from "./helpers.js";

const at = "2026-11-13T11:00:00.000Z";
const origin = { thread: "T", turn: "U", attempt: "A", backend: "codex", native: { runtime: "R", item: "native-1" } };
const native = { kind: "native", itemId: "tool-1", origin };
function evidence() {
  const origin = structuredClone({ thread: "T", turn: "U", attempt: "A", backend: "codex", native: { runtime: "R", item: "native-1" } });
  const native = { kind: "native", itemId: "tool-1", origin };
  return { revision: 3, refs: [{ id: "f1", target: { kind: "file", path: "src/check.ts" }, relations: [
    { kind: "relevant", provenance: "model-proposed", source: { kind: "model-proposal", turn: { thread: "T", turn: "U", attempt: "A", backend: "codex" }, leaseId: "L", receiptId: "P", requestId: 1, at } },
    { kind: "read", provenance: "observed", source: native },
    { kind: "relevant", provenance: "user-confirmed", source: { kind: "human", actionId: "H", at } },
  ], captureIds: ["c1"] }], captures: [{ id: "c1", target: { kind: "file", path: "src/check.ts" }, source: native, phase: "after-native-result", startedAt: at, finishedAt: at, repository: { state: "available", head: "a".repeat(40) }, revision: { state: "available", algorithm: "sha256", digest: "b".repeat(64), bytes: 12 } }], checks: [{ itemId: "check-1", eventIds: ["A:4", "A:5"], origin, planRevision: 2, command: "pnpm test", outcome: "succeeded", exitCode: 0, scope: "project", relevantRefIds: ["f1"], relevance: "user-confirmed", startCaptureIds: ["c1"], endCaptureIds: ["c1"], staleness: "current-observation" }] };
}
function snapshot(contextEvidence?: unknown) {
  return { version: 1, pageId: "N", revision: 1, projectId: "P", threadId: "T", turnId: "U", savedAt: at, record: { title: "Task", threadId: "T", request: "Check", files: [], outsideFiles: 0, commands: [], clarifications: [], ...(contextEvidence === undefined ? {} : { contextEvidence }) } };
}

test("saved task refuses malformed context rather than reopening it as trusted legacy evidence", () => {
  assert.equal(tasks.isTaskSnapshot(snapshot()), true);
  assert.equal(tasks.isTaskSnapshot(snapshot(evidence())), true);
  assert.equal(tasks.isTaskSnapshot(snapshot({ revision: 3, refs: "forged", captures: [], checks: [] })), false);
});

test("task record preserves one turn's provenance separately and without mutable aliases", () => {
  const contextEvidence = evidence();
  const user = Object.assign({ kind: "user", id: "U", text: "Check", at }, { contextEvidence }) as ThreadItem;
  const record = tasks.taskRecord([user], { threadId: "T", title: "Task", cwd: "/repo" });
  assert.deepEqual((record as unknown as { contextEvidence: unknown }).contextEvidence, contextEvidence);
  contextEvidence.refs[0]!.captureIds.push("later");
  assert.deepEqual((record as unknown as { contextEvidence: ReturnType<typeof evidence> }).contextEvidence.refs[0]!.captureIds, ["c1"]);
});

test("snapshot refuses foreign links, forged source combinations and private bodies", () => {
  const cases = [
    (d: ReturnType<typeof evidence>) => { d.refs[0]!.captureIds = ["foreign"]; },
    (d: ReturnType<typeof evidence>) => { d.checks[0]!.relevantRefIds = ["foreign"]; },
    (d: ReturnType<typeof evidence>) => { Object.assign(d.refs[0]!.relations[0]!.source, { origin }); },
    (d: ReturnType<typeof evidence>) => { Object.assign(d.captures[0]!, { markdown: "private body" }); },
    (d: ReturnType<typeof evidence>) => { d.refs[0]!.target.path = "/private/source.ts"; },
    (d: ReturnType<typeof evidence>) => { d.refs[0]!.target.path = "../other/source.ts"; },
    (d: ReturnType<typeof evidence>) => { d.captures[0]!.revision.digest = "made up"; },
    (d: ReturnType<typeof evidence>) => { d.captures[0]!.finishedAt = "not a time"; },
  ];
  for (const mutate of cases) { const d = evidence(); mutate(d); assert.equal(tasks.isTaskSnapshot(snapshot(d)), false); }
});

test("snapshot keeps every ref beyond the display limit and validates unavailable history receipts", () => {
  const d = evidence();
  d.refs = Array.from({ length: 25 }, (_, i) => ({ id: `ref-${i}`, target: { kind: "file", path: `src/file-${i}.ts` }, relations: [], captureIds: [] }));
  d.refs[0]!.captureIds = ["c1"];
  d.captures[0]!.target = { kind: "file", path: "src/file-0.ts" };
  d.checks[0]!.relevantRefIds = ["ref-24"];
  assert.equal(tasks.isTaskSnapshot(snapshot(d)), true);
  const stored = tasks.taskRecord([Object.assign({ kind: "user", id: "U", text: "Check", at }, { contextEvidence: d }) as ThreadItem], { threadId: "T", title: "Task", cwd: "/repo" });
  assert.equal(stored.contextEvidence!.refs.length, 25);
  assert.deepEqual(stored.contextEvidence!.checks[0]!.eventIds, ["A:4", "A:5"]);
  const historical = { revision: 0, refs: [{ id: "note", target: { kind: "note", pageId: "N" }, relations: [{ kind: "read", provenance: "observed", source: { kind: "notes-read", turn: { thread: "T", turn: "U", attempt: "A", backend: "claude" }, leaseId: "L", receiptId: "history-8", requestId: "req", at, method: "history" } }], captureIds: ["old"] }], captures: [{ id: "old", target: { kind: "note", pageId: "N" }, source: { kind: "notes-read", turn: { thread: "T", turn: "U", attempt: "A", backend: "claude" }, leaseId: "L", receiptId: "history-8", requestId: "req", at, method: "history" }, phase: "after-native-result", startedAt: at, finishedAt: at, repository: { state: "unavailable", reason: "not-repository" }, revision: { state: "unavailable", reason: "budget" }, noteVersion: { via: "history", updatedAt: at, revision: 8 } }], checks: [] };
  assert.equal(tasks.isTaskSnapshot(snapshot(historical)), true);
});

test("projection refuses another turn's evidence and legacy projection invents none", () => {
  const d = evidence();
  d.captures[0]!.source.origin.turn = "OTHER";
  assert.equal(tasks.isTaskSnapshot(snapshot(d)), false);
  const user = { kind: "user", id: "U", text: "Check", at } as const;
  assert.throws(() => tasks.taskRecord([user], { threadId: "T", title: "Task", cwd: "/repo", contextEvidence: d as tasks.TaskContextEvidence }), /belong/);
  const legacy = tasks.taskRecord([user], { threadId: "T", title: "Task", cwd: "/repo" });
  assert.equal(Object.hasOwn(legacy, "contextEvidence"), false);
});

test("context identities distinguish kinds and literal delimiters without collapsing a long project path", () => {
  assert.notEqual(tasks.contextRefId({ kind: "file", path: "note:N" }), tasks.contextRefId({ kind: "note", pageId: "N" }));
  assert.notEqual(tasks.contextRefId({ kind: "note", pageId: "N" }), tasks.contextRefId({ kind: "notes-file", id: "N" }));
  assert.notEqual(tasks.contextRefId({ kind: "file", path: 'a","b' }), tasks.contextRefId({ kind: "file", path: 'a,b' }));
  const d = evidence();
  const path = "a/".repeat(300) + "test.ts";
  const id = tasks.contextRefId({ kind: "file", path });
  d.refs = [{ id, target: { kind: "file", path }, relations: [], captureIds: [] }];
  d.captures = []; d.checks = [];
  assert.equal(tasks.isTaskSnapshot(snapshot(d)), true);
});

test("historical Note retains exact returned revision even when its digest is unavailable", () => {
  const source = { kind: "notes-read", turn: { thread: "T", turn: "U", attempt: "A", backend: "claude" }, leaseId: "L", receiptId: "h8", requestId: 1, at, method: "history" };
  const capture = { id: "h8", target: { kind: "note", pageId: "N" }, source, phase: "after-native-result", startedAt: at, finishedAt: at, repository: { state: "unavailable", reason: "not-repository" }, revision: { state: "unavailable", reason: "budget" }, noteVersion: { via: "history", updatedAt: at, revision: 8 } };
  const d = { revision: 1, refs: [{ id: "n", target: { kind: "note", pageId: "N" }, relations: [], captureIds: ["h8"] }], captures: [capture], checks: [] };
  assert.equal(tasks.isTaskSnapshot(snapshot(d)), true);
  delete (capture.noteVersion as { revision?: number }).revision;
  assert.equal(tasks.isTaskSnapshot(snapshot(d)), false, "a historical Note cannot lose its returned revision just because no hash was made");
});

test("requested native operation and model relevance proposal remain distinct", () => {
  const d = evidence();
  d.refs[0]!.relations.push({ kind: "read", provenance: "native-requested", source: structuredClone(native) } as unknown as ReturnType<typeof evidence>["refs"][number]["relations"][number]);
  assert.equal(tasks.isTaskSnapshot(snapshot(d)), true);
  d.refs[0]!.relations[0]!.source = structuredClone(native) as unknown as ReturnType<typeof evidence>["refs"][number]["relations"][number]["source"];
  assert.equal(tasks.isTaskSnapshot(snapshot(d)), false, "native operation intent is not an independent model relevance proposal");
});


test("main transcript storage and journal replay preserve provenance without migration or recapture", () => {
  const home = tmpdir("modex-context-persist-");
  const store = new Store(home);
  const journal = new EventJournal(path.join(home, "events.sqlite"));
  const user = Object.assign({ kind: "user", id: "U", text: "Check", at }, { contextEvidence: evidence() }) as ThreadItem;
  try {
    store.saveItems("T", [user]);
    journal.record({ threadId: "T", type: "item", item: user }); journal.flush();
    const restored = new Store(home).items("T");
    assert.deepEqual(restored, [user]);
    assert.deepEqual(replayItems(journal.since(0, { threadId: "T" }), "T"), restored);
    const record = tasks.taskRecord(restored, { threadId: "T", title: "Task", cwd: "/deleted-project" });
    assert.deepEqual(record.contextEvidence, evidence(), "projection uses the original receipts despite the missing project");
  } finally { journal.close(); }
});
