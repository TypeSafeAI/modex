import { test } from "node:test";
import assert from "node:assert/strict";
import { CONVERSATION_SCHEMA, projectConversation, type ConversationEvent, type Observation, type AttemptMark, type TurnRef } from "../src/shared/conversation-events.js";
import { taskRecord, taskMarkdown } from "../src/shared/task-context.js";
import { CodexBackend } from "../src/main/engine/backends/codex.js";
import { ClaudeBackend } from "../src/main/engine/backends/claude.js";
import type { ThreadItem } from "../src/shared/types.js";
import { FakeProcess, collectSink, fakeSpawn } from "./fakeproc.js";

/**
 * A task's plan and record (docs/task-context.md): the plan the CLI reported, in its own words and
 * statuses, kept per revision; and a portable summary of request, plan, files, checks and loose ends.
 * "Done" here is what the CLI reported. Nothing is called verified.
 */

const turn: TurnRef = { thread: "T", turn: "U", attempt: "A1", backend: "codex" };
function stream() {
  let seq = 0;
  return (body: Observation | AttemptMark): ConversationEvent => ({ schema: CONVERSATION_SCHEMA, id: `A1:${++seq}`, seq, at: new Date(Date.UTC(2026, 9, 18, 9, 0, seq)).toISOString(), turn, ...body }) as ConversationEvent;
}
const plan = { runtime: "R", thread: "nt", turn: "nu", item: "plan" };

test("plan updates are revisions of one plan; completed steps are reported done, never verified", () => {
  const e = stream();
  const state = projectConversation([
    e({ type: "attempt.start" }),
    e({ type: "plan.update", native: plan, from: "codex-plan", explanation: "Two steps", steps: [{ text: "Read the config", status: "in-progress" }, { text: "Fix the import", status: "pending" }] }),
    e({ type: "plan.update", native: plan, from: "codex-plan", steps: [{ text: "Read the config", status: "completed" }, { text: "Fix the import", status: "in-progress" }] }),
    e({ type: "attempt.end", outcome: "interrupted" }),
  ]);
  assert.equal(state.items.length, 1);
  const item = state.items[0] as ThreadItem & { kind: "plan" };
  assert.equal(item.kind, "plan");
  assert.equal(item.revision, 2);
  assert.equal(item.from, "codex-plan");
  assert.equal(item.explanation, undefined, "the latest revision's own explanation, not an older one");
  assert.deepEqual(item.steps, [{ text: "Read the config", status: "completed" }, { text: "Fix the import", status: "in-progress" }]);
  assert.equal(item.outcome, "interrupted", "the turn stopped; the steps say what was last reported");
});

/** A Codex app-server that answers setup, then plays `lines` after turn/start. */
function codexWith(lines: unknown[]) {
  const proc = new FakeProcess();
  proc.stdin.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n")) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as { id?: number; method?: string };
      if (msg.method === "initialize") proc.emitLine({ id: msg.id, result: { userAgent: "fake" } });
      else if (msg.method === "thread/start") proc.emitLine({ id: msg.id, result: { thread: { id: "thr" } } });
      else if (msg.method === "turn/start") {
        proc.emitLine({ id: msg.id, result: { turn: { id: "tu" } } });
        proc.emitLine({ method: "turn/started", params: { threadId: "thr", turn: { id: "tu" } } });
        for (const l of lines) proc.emitLine(l);
        proc.emitLine({ method: "turn/completed", params: { threadId: "thr", turn: { id: "tu", status: "completed", error: null } } });
      }
    }
  });
  return new CodexBackend("codex", fakeSpawn(proc).spawn);
}

test("Codex: turn/plan/updated becomes a plan update with its steps, statuses and explanation", async () => {
  // Shaped by codex-cli 0.163.0's generated TurnPlanUpdatedNotification (synthetic content).
  const backend = codexWith([{ method: "turn/plan/updated", params: { threadId: "thr", turnId: "tu", explanation: "Small fix", plan: [{ step: "Read the config", status: "completed" }, { step: "Fix the import", status: "inProgress" }, { step: "Run the tests", status: "pending" }] } }]);
  const { sink, observations } = collectSink();
  try {
    await backend.runTurn("go", { cwd: "/repo", mode: "agent", plan: false, model: "" }, sink, new AbortController().signal);
    const update = observations.find((o) => o.type === "plan.update") as { from: string; explanation?: string; steps: unknown[]; native: { item: string; turn?: string } };
    assert.equal(update.from, "codex-plan");
    assert.equal(update.explanation, "Small fix");
    assert.deepEqual(update.steps, [{ text: "Read the config", status: "completed" }, { text: "Fix the import", status: "in-progress" }, { text: "Run the tests", status: "pending" }]);
    assert.equal(update.native.turn, "tu");
  } finally { await backend.dispose(); }
});

test("Claude: a TodoWrite call is a plan update; a status Modex does not know stays unknown", async () => {
  const proc = new FakeProcess();
  const backend = new ClaudeBackend("claude", fakeSpawn(proc).spawn);
  const { sink, observations } = collectSink();
  const run = backend.runTurn("go", { cwd: "/repo", mode: "agent", plan: false, model: "" }, sink, new AbortController().signal);
  await proc.waitFor((l) => l.includes('"type":"user"'));
  proc.emitLine({ type: "system", subtype: "init", session_id: "s" });
  proc.emitLine({ type: "assistant", message: { id: "m", content: [{ type: "tool_use", id: "tu1", name: "TodoWrite", input: { todos: [
    { content: "Read the config", status: "completed", activeForm: "Reading the config" },
    { content: "Fix the import", status: "in_progress", activeForm: "Fixing the import" },
    { content: "Ship it", status: "blocked", activeForm: "Shipping" },
  ] } }] } });
  proc.emitLine({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "Todos updated" }] } });
  proc.emitLine({ type: "assistant", message: { id: "m2", content: [{ type: "text", text: "Working on it." }] } });
  proc.emitLine({ type: "result", subtype: "success", is_error: false, session_id: "s", result: "Working on it.", num_turns: 2 });
  proc.close(0);
  await run;
  const update = observations.find((o) => o.type === "plan.update") as { from: string; steps: unknown[] };
  assert.equal(update.from, "claude-todo");
  assert.deepEqual(update.steps, [{ text: "Read the config", status: "completed" }, { text: "Fix the import", status: "in-progress" }, { text: "Ship it", status: "unknown" }]);
});

test("a task record summarises request, plan, files, checks and loose ends, without reasoning, logs or private paths", () => {
  const at = "2026-10-18T09:00:00.000Z";
  const origin = { thread: "T", turn: "u1", attempt: "A1", backend: "codex" as const, native: { runtime: "R", item: "x" } };
  const items: ThreadItem[] = [
    { id: "u1", kind: "user", text: "Fix the failing import", at },
    { id: "r", kind: "thinking", text: "PRIVATE REASONING", reasoning: "summary", status: "done", outcome: "succeeded", origin, at },
    { id: "p", kind: "plan", steps: [{ text: "Fix the import", status: "completed" }, { text: "Run the tests", status: "in-progress" }], from: "codex-plan", revision: 3, outcome: "succeeded", origin, at },
    { id: "e", kind: "tool", name: "apply_patch", title: "edit src/a.ts, /Users/val/secret/b.ts", args: { patch: "x" }, status: "done", outcome: "succeeded", ok: true, origin, at },
    { id: "c1", kind: "tool", name: "shell", title: "$ npm test", args: {}, exec: { command: "npm test", cwd: "/repo" }, exitCode: 1, output: "LOTS OF LOG", status: "done", outcome: "failed", ok: false, origin, at },
    { id: "c2", kind: "tool", name: "shell", title: "$ rm -rf build", args: {}, exec: { command: "rm -rf build", cwd: "/repo" }, exitCode: null, status: "done", outcome: "denied", ok: false, origin, at },
    { id: "f", kind: "assistant", text: "Fixed the import; one test still fails.", phase: "final", outcome: "succeeded", origin, at },
  ] as ThreadItem[];
  const record = taskRecord(items, { threadId: "T", title: "Fix import", cwd: "/repo" });
  assert.deepEqual(record.files, ["src/a.ts"], "files inside the project, relative; others are not named");
  assert.equal(record.outsideFiles, 1);
  const md = taskMarkdown(record);
  for (const expected of ["# Fix import", "Fix the failing import", "- [x] Fix the import (reported done)", "- [ ] Run the tests (in progress)", "`src/a.ts`",
    "`npm test` — failed, exit code 1", "`rm -rf build` — denied, no exit code", "Fixed the import; one test still fails.", "modex thread T"]) {
    assert.ok(md.includes(expected), `missing: ${expected}\n${md}`);
  }
  assert.match(md, /## Not settled\n[\s\S]*`npm test`[\s\S]*`rm -rf build`/);
  for (const absent of ["PRIVATE REASONING", "LOTS OF LOG", "/Users/val", "verified", "Verified"]) assert.ok(!md.includes(absent), `must not include: ${absent}`);
});

test("a task record lists each clarification with its answer, a secret hidden, and says when one was not answered or not confirmed; it invents none", () => {
  const at = "2026-10-18T09:00:00.000Z";
  const q = (id: string, header: string, text: string, secret = false) => ({ id, header, text, options: null, allowOther: true, secret });
  const items: ThreadItem[] = [
    { id: "u1", kind: "user", text: "Deploy the fix", at },
    { id: "ask-1", kind: "question", blocking: true, questions: [q("env", "Environment", "Which environment?"), q("token", "Token", "Paste the deploy token", true)],
      answers: { env: ["staging"], token: ["(hidden)"] }, answeredBy: "desktop", delivery: "sent", at },
    { id: "ask-2", kind: "question", blocking: true, questions: [q("branch", "Branch", "Which branch?")], withdrawn: "stopped", at },
    { id: "ask-3", kind: "question", blocking: true, questions: [q("notes", "Notes", "Add release notes?")], answers: { notes: ["yes"] }, answeredBy: "phone", delivery: "uncertain", at },
    { id: "ask-4", kind: "question", blocking: false, questions: [q("region", "Region", "Which region?")], withdrawn: "native", at },
    { id: "f", kind: "assistant", text: "Deployed to staging.", phase: "final", outcome: "succeeded", at },
  ] as ThreadItem[];
  const record = taskRecord(items, { threadId: "T", title: "Deploy", cwd: "/repo" });
  assert.deepEqual(record.clarifications, [
    { question: "Which environment?", answer: ["staging"] },
    { question: "Paste the deploy token", answer: ["(hidden)"] },
    { question: "Which branch?", answer: null, closed: "stopped" },
    { question: "Add release notes?", answer: ["yes"], uncertain: true },
    { question: "Which region?", answer: null, closed: "native" },
  ]);
  const md = taskMarkdown(record);
  for (const expected of ["## Clarifications", "- Which environment? — staging", "- Paste the deploy token — (hidden)", "- Which branch? — not answered: the turn was stopped",
    "- Add release notes? — yes (Modex could not confirm the agent received this answer)", "- Which region? — not answered: the agent withdrew it"]) {
    assert.ok(md.includes(expected), `missing: ${expected}\n${md}`);
  }
  assert.match(md, /## Not settled\n[\s\S]*Which branch\? — not answered[\s\S]*Add release notes\?/);
  assert.ok(!/Which environment\?[^\n]*\n[\s\S]*## Not settled[\s\S]*Which environment/.test(md), "an answered, sent clarification is settled");
  // A turn with no questions has no section, and old records read as before.
  assert.equal(taskMarkdown(taskRecord(items.filter((i) => i.kind !== "question"), { threadId: "T", title: "Deploy", cwd: "/repo" })).includes("Clarifications"), false);
});

test("Save task to Notes writes the turn's record into its project's notes; saving again updates it, and a note edited since is kept", async () => {
  const { Store } = await import("../src/main/engine/store.js");
  const { ThreadRunner } = await import("../src/main/engine/runner.js");
  const { gitRepo, tmpdir } = await import("./helpers.js");
  const { local } = await import("./fakeproc.js");
  const home = tmpdir("modex-task-note-");
  const store = new Store(home);
  const repo = gitRepo();
  const backend = { id: "claude" as const, listModels: async () => [], dispose: async () => {}, async runTurn(_t: string, _o: unknown, sink: import("../src/main/engine/backends/types.js").TurnSink) {
    sink.observe({ type: "plan.update", native: { runtime: "R", item: "todos" }, from: "claude-todo", steps: [{ text: "Fix the import", status: "completed" }] });
    local(sink).toolStart({ id: "e1", name: "Edit", title: "edit src/a.ts", args: { file_path: `${repo}/src/a.ts` } });
    local(sink).toolUpdate("e1", { status: "done", ok: true });
    local(sink).assistant("Fixed the import.");
    return { status: "completed" as const };
  } };
  const runner = new ThreadRunner({ home, store, emit: () => {}, backends: { claude: backend } });
  const project = store.addProject(repo);
  const thread = await runner.createThread(project.id, { backend: "claude", auto: false });
  store.updateThread(thread.id, { title: "Fix import", titleSource: "manual" });
  await runner.send(thread.id, "Fix the failing import");
  const turnId = runner.items(thread.id).find((item) => item.kind === "user")!.id;
  const notesProject = store.space.tree().nodes.find((node) => node.kind === "project" && node.modexProjectId === project.id)!;

  const first = runner.saveTaskNote(thread.id, turnId);
  const page = () => store.space.list().find((p) => p.id === first.pageId)!;
  assert.equal(first.created, true);
  assert.match(page().markdown, /- \[x\] Fix the import \(reported done\)/);
  assert.match(page().markdown, /`src\/a\.ts`/);
  assert.ok(!page().markdown.includes(repo), "no absolute path from this machine");
  assert.equal(store.space.tree().nodes.find((node) => node.kind === "note" && node.id === first.pageId)?.parentId, notesProject.id, "it lands in the project's notes");

  const again = runner.saveTaskNote(thread.id, turnId);
  assert.deepEqual([again.pageId, again.created], [first.pageId, false], "saving again updates the same note");
  assert.equal(store.space.list().filter((p) => p.title === first.title).length, 1, "no duplicate");

  // Someone edits the note; the next save keeps their edit and writes this version beside it.
  store.space.save({ ...page(), markdown: page().markdown + "\nMy own notes.\n" });
  const third = runner.saveTaskNote(thread.id, turnId);
  assert.notEqual(third.pageId, first.pageId);
  assert.equal(third.preserved, true);
  assert.match(store.space.list().find((p) => p.id === first.pageId)!.markdown, /My own notes\./, "the edited note is untouched");
  assert.throws(() => runner.saveTaskNote(thread.id, "no-such-turn"), /no longer in this thread/);
  await runner.dispose();
});
