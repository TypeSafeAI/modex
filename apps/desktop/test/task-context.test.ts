import { test } from "node:test";
import assert from "node:assert/strict";
import { CONVERSATION_SCHEMA, projectConversation, type ConversationEvent, type Observation, type AttemptMark, type TurnRef } from "../src/shared/conversation-events.js";
import { CONTEXT_SHOWN, UNLISTED_WORDS, contextCount, displayCommand, isCheckCommand, isTaskSnapshot, noPlan, taskContext, taskRecord, taskMarkdown, verification } from "../src/shared/task-context.js";
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

for (const move of ["Finder across projects", "watched Finder across projects", "folder across projects", "folder within project"] as const) {
  test(`Save task Note preserves project ownership after ${move}`, async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { Store } = await import("../src/main/engine/store.js");
    const { ThreadRunner } = await import("../src/main/engine/runner.js");
    const { gitRepo, tmpdir } = await import("./helpers.js");
    const { local } = await import("./fakeproc.js");
    const home = tmpdir("modex-task-note-scope-");
    const store = new Store(home);
    const backend = { id: "claude" as const, listModels: async () => [], dispose: async () => {}, async runTurn(_t: string, _o: unknown, sink: import("../src/main/engine/backends/types.js").TurnSink) {
      local(sink).assistant("Task finished.");
      return { status: "completed" as const };
    } };
    const runner = new ThreadRunner({ home, store, emit: () => {}, backends: { claude: backend } });
    try {
      const project = store.addProject(gitRepo());
      const other = store.addProject(gitRepo());
      const thread = await runner.createThread(project.id, { backend: "claude", auto: false });
      await runner.send(thread.id, "Summarize this task");
      const turnId = runner.items(thread.id).find(item => item.kind === "user")!.id;
      const notes = store.space;
      const own = notes.tree().nodes.find(node => node.kind === "project" && node.modexProjectId === project.id)!;
      const foreign = notes.tree().nodes.find(node => node.kind === "project" && node.modexProjectId === other.id)!;
      const saved = runner.saveTaskNote(thread.id, turnId);
      if (move === "watched Finder across projects") notes.watch();
      if (move === "Finder across projects" || move === "watched Finder across projects") {
        const rel = notes.pageRels().get(saved.pageId)!;
        fs.renameSync(path.join(home, "notes", rel), path.join(home, "notes", foreign.rel, path.basename(rel)));
      } else {
        const folder = notes.createFolder(own.id, "Task folder");
        // Finder can put the note into a plain folder without changing content or revision.
        const rel = notes.pageRels().get(saved.pageId)!;
        fs.renameSync(path.join(home, "notes", rel), path.join(home, "notes", folder.rel, path.basename(rel)));
        notes.list();
        const destination = move === "folder across projects" ? foreign.id : notes.createFolder(own.id, "Archive").id;
        notes.moveNodes([folder.id], destination);
      }
      const moved = notes.list().find(page => page.id === saved.pageId)!;
      assert.equal(moved.revision, saved.revision, "moving ownership can preserve a note revision");
      const cachedRel = notes.pageRels().get(saved.pageId)!;
      if (move === "watched Finder across projects") assert.ok(cachedRel.startsWith(`${own.rel}/`), "watcher has not delivered the synchronous move yet");
      const movedRel = move === "watched Finder across projects" ? `${foreign.rel}/${path.basename(cachedRel)}` : cachedRel;
      const bytes = fs.readFileSync(path.join(home, "notes", movedRel), "utf8");
      const result = runner.saveTaskNote(thread.id, turnId);
      if (move === "folder within project") {
        assert.equal(result.pageId, saved.pageId, "same-project moves still update the associated note");
        assert.equal(result.created, false);
      } else {
        assert.notEqual(result.pageId, saved.pageId, "a note moved to another project must not be overwritten");
        assert.equal(result.preserved, true);
        assert.equal(fs.readFileSync(path.join(home, "notes", movedRel), "utf8"), bytes);
        assert.ok(notes.pageRels().get(result.pageId)!.startsWith(`${own.rel}/`), "replacement belongs to the original project");
        assert.equal(store.thread(thread.id)!.taskNotes?.[turnId]?.pageId, result.pageId);
      }
    } finally { store.space.unwatch(); await runner.dispose(); }
  });
}

// Reopen (CF-7 #280): a saved task note opens as the record it saved, read-only.

/** A runner whose scripted Claude reports a plan, an edit and a passing check, counting every call into the backend. */
async function reopenFixture() {
  const { Store } = await import("../src/main/engine/store.js");
  const { ThreadRunner } = await import("../src/main/engine/runner.js");
  const { gitRepo, tmpdir } = await import("./helpers.js");
  const { local } = await import("./fakeproc.js");
  const home = tmpdir("modex-task-reopen-");
  const store = new Store(home);
  const repo = gitRepo();
  const calls = { turns: 0, other: 0 };
  const backend = { id: "claude" as const, listModels: async () => { calls.other++; return []; }, dispose: async () => {}, async runTurn(_t: string, _o: unknown, sink: import("../src/main/engine/backends/types.js").TurnSink) {
    calls.turns++;
    sink.observe({ type: "plan.update", native: { runtime: "R", item: "todos" }, from: "claude-todo", steps: [{ text: "Fix the import", status: "completed" }, { text: "Run the tests", status: "completed" }] });
    local(sink).toolStart({ id: `e${calls.turns}`, name: "Edit", title: "edit src/a.ts", args: { file_path: `${repo}/src/a.ts` } });
    local(sink).toolUpdate(`e${calls.turns}`, { status: "done", ok: true });
    sink.observe({ type: "tool.start", native: { runtime: "R", item: `c${calls.turns}` }, tool: { name: "Bash", title: "$ pnpm test", args: { command: "pnpm test" }, exec: { command: "pnpm test" } } });
    sink.observe({ type: "tool.done", native: { runtime: "R", item: `c${calls.turns}` }, outcome: "succeeded" });
    local(sink).assistant(`Fixed the import (turn ${calls.turns}).`);
    return { status: "completed" as const };
  } };
  const runner = new ThreadRunner({ home, store, emit: () => {}, backends: { claude: backend } });
  const project = store.addProject(repo);
  const thread = await runner.createThread(project.id, { backend: "claude", auto: false });
  store.updateThread(thread.id, { title: "Fix import", titleSource: "manual" });
  await runner.send(thread.id, "Fix the failing import");
  const turnId = runner.items(thread.id).find((item) => item.kind === "user")!.id;
  return { home, repo, store, runner, project, thread, turnId, calls };
}

/** Every file under `dir`, with its bytes and modification time, to prove nothing was written. */
async function filesUnder(dir: string): Promise<string> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
    .map((entry) => { const file = path.join(entry.parentPath, entry.name); return `${file}\0${fs.statSync(file).mtimeMs}\0${fs.readFileSync(file, "base64")}`; }).sort().join("\n");
}

test("a saved task note reopens as the record it saved: plan, files, verification, with no turn, no CLI call and no write", async () => {
  const path = await import("node:path");
  const { home, store, runner, thread, turnId, calls } = await reopenFixture();
  try {
    const turn = runner.items(thread.id);
    const saved = runner.saveTaskNote(thread.id, turnId);
    const expected = taskRecord(turn, { threadId: thread.id, title: saved.title, cwd: thread.cwd });
    // A later turn changes the thread; the note's record stays what was saved.
    await runner.send(thread.id, "Now do it again");
    const before = { calls: { ...calls }, items: JSON.stringify(runner.items(thread.id)), thread: JSON.stringify(store.thread(thread.id)), notes: await filesUnder(path.join(home, "notes")) };

    const view = runner.taskNote(saved.pageId)!;
    assert.ok(view, "a saved task note has a task view");
    assert.deepEqual(view.record, expected, "the record as saved, not rebuilt from today's transcript");
    assert.deepEqual(view.record.plan?.steps.map((step) => step.status), ["completed", "completed"]);
    assert.deepEqual(view.record.context?.files.map((file) => file.path), ["src/a.ts"]);
    assert.equal(view.record.verification?.state, "verified");
    assert.match(view.record.answer ?? "", /turn 1/);
    assert.deepEqual([view.threadId, view.turnId, view.savedRevision, view.note.revision], [thread.id, turnId, saved.revision, saved.revision]);
    assert.equal(view.edited, undefined);
    assert.equal(view.moved, undefined);
    assert.equal(view.superseded, undefined);
    assert.equal(view.thread, true);

    // Opening it again, many times, still runs nothing and writes nothing.
    for (let i = 0; i < 3; i++) runner.taskNote(saved.pageId);
    assert.deepEqual(calls, before.calls, "no turn and no CLI call");
    assert.equal(JSON.stringify(runner.items(thread.id)), before.items, "the transcript is untouched");
    assert.equal(JSON.stringify(store.thread(thread.id)), before.thread, "the thread is untouched");
    assert.equal(await filesUnder(path.join(home, "notes")), before.notes, "no note or record file was written");

    // A page that is not a saved task, or no page at all, has no task view.
    const plain = store.space.create({ title: "Just a page", markdown: "Hello" });
    assert.equal(runner.taskNote(plain.id), null);
    assert.equal(runner.taskNote("no-such-page"), null);
  } finally { await runner.dispose(); }
});

test("a reopened task note says when it was edited after it was saved, and which note a later save went to", async () => {
  const { store, runner, thread, turnId } = await reopenFixture();
  try {
    const saved = runner.saveTaskNote(thread.id, turnId);
    const page = () => store.space.list().find((p) => p.id === saved.pageId)!;
    store.space.save({ ...page(), markdown: page().markdown + "\nMy own notes.\n" });
    const edited = runner.taskNote(saved.pageId)!;
    assert.deepEqual({ ...edited.edited, at: undefined }, { revision: saved.revision + 1, by: "you", at: undefined });
    assert.ok(Date.parse(edited.edited!.at));
    assert.equal(edited.note.revision, saved.revision + 1);
    assert.equal(edited.savedRevision, saved.revision);
    assert.equal(edited.record.request, "Fix the failing import", "the record is the one saved, whatever the note says now");

    // Saving again keeps the edit and writes a new note; the old note's view points to it.
    const again = runner.saveTaskNote(thread.id, turnId);
    assert.equal(again.preserved, true);
    assert.deepEqual(runner.taskNote(saved.pageId)!.superseded, { pageId: again.pageId, title: again.title });
    const fresh = runner.taskNote(again.pageId)!;
    assert.equal(fresh.edited, undefined);
    assert.equal(fresh.superseded, undefined);

    // Trashing the note is said too.
    store.space.trash(again.pageId, true);
    assert.equal(runner.taskNote(again.pageId)!.note.trashed, true);
  } finally { await runner.dispose(); }
});

test("a reopened task note says when it was moved to another project's notes, and not for a move within its project", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { gitRepo } = await import("./helpers.js");
  const { home, store, runner, thread, turnId, project } = await reopenFixture();
  try {
    const other = store.addProject(gitRepo());
    const notes = store.space;
    const own = notes.tree().nodes.find((node) => node.kind === "project" && node.modexProjectId === project.id)!;
    const foreign = notes.tree().nodes.find((node) => node.kind === "project" && node.modexProjectId === other.id)!;
    const saved = runner.saveTaskNote(thread.id, turnId);

    // Within the project: a folder move is no move across projects.
    const folder = notes.createFolder(own.id, "Archive");
    notes.moveNodes([saved.pageId], folder.id);
    const within = runner.taskNote(saved.pageId)!;
    assert.equal(within.moved, undefined);

    // Finder moves it to another project's notes: the revision can stay the same (#363).
    const rel = notes.pageRels().get(saved.pageId)!;
    fs.renameSync(path.join(home, "notes", rel), path.join(home, "notes", foreign.rel, path.basename(rel)));
    // The notes store records where it found the file on its next look, as Space's own reads do.
    notes.list();
    const before = await filesUnder(path.join(home, "notes"));
    const moved = runner.taskNote(saved.pageId)!;
    assert.deepEqual(moved.moved, { from: own.name, to: foreign.name });
    assert.equal(moved.record.request, "Fix the failing import");
    assert.equal(await filesUnder(path.join(home, "notes")), before, "noticing the move writes nothing");
  } finally { await runner.dispose(); }
});

// Verification (CF-7 #280): a check's observed result, tied to the turn's latest change.
let seqId = 0;
const at = (n: number) => new Date(Date.UTC(2026, 9, 20, 9, 0, n)).toISOString();
const run = (command: string, outcome: "succeeded" | "failed" | "denied" | "interrupted" | "unknown", exitCode?: number | null): ThreadItem =>
  ({ id: `t${++seqId}`, kind: "tool", name: "shell", title: `$ ${command}`, args: { command }, status: "done", outcome, ok: outcome === "succeeded", exec: { command }, ...(exitCode !== undefined ? { exitCode } : {}), at: at(seqId) }) as ThreadItem;
const edit = (file: string, outcome: "succeeded" | "denied" | "failed" = "succeeded"): ThreadItem =>
  ({ id: `t${++seqId}`, kind: "tool", name: "apply_patch", title: `edit ${file}`, args: {}, status: "done", outcome, ok: outcome === "succeeded", at: at(seqId) }) as ThreadItem;
const user: ThreadItem = { id: "U", kind: "user", text: "Fix the import", at: at(0) } as ThreadItem;

test("a check is a known test, build, typecheck or lint command, unwrapped from its shell; nothing else is", () => {
  for (const command of ["pnpm test", "pnpm --filter @modex/desktop test", "pnpm test:e2e", "npm run build", "yarn lint", "bun run typecheck", "node --test dist/test",
    "npx tsc --noEmit", "pnpm exec playwright test e2e/a.spec.ts", "pytest -q", "python3 -m pytest tests", "cargo test", "cargo clippy", "go test ./...", "swift test",
    "make test", "/bin/zsh -lc 'pnpm test'", "bash -c \"cd pkg && npm test\"", "pnpm build && pnpm test"]) {
    assert.equal(isCheckCommand(command), true, command);
  }
  for (const command of ["echo ok", "ls -la", "git status --short", "grep -q 'hello, live' greeting.txt", "cat package.json", "npm install", "pnpm add left-pad",
    "node scripts/build-site.js", "pnpm dev", "make", "/bin/zsh -c \"grep -q 'x' f\"", "echo 'pnpm test'"]) {
    assert.equal(isCheckCommand(command), false, command);
  }
});

test("shell control flow cannot hide a failed check or a write after a check", () => {
  for (const command of [
    "pnpm test || true", "pnpm test; true", "pnpm test\ntrue", "pnpm test | cat", "pnpm test &",
    "pnpm test && printf broken > app.ts", "pnpm test; printf broken > app.ts",
    "pnpm test && node rewrite.js", "pnpm test > app.ts", "pnpm test $(touch app.ts)",
    'pnpm test "$(touch app.ts)"', "pnpm test `touch app.ts`", "pnpm test # && false",
    "bash -c 'pnpm test || true'", "bash -c 'pnpm test && printf broken > app.ts'",
    "pnpm test &&", "&& pnpm test", "pnpm test 'unterminated",
    "bash -n -c 'pnpm test'", "bash -nc 'pnpm test'", "bash -o noexec -c 'pnpm test'",
  ]) {
    assert.equal(isCheckCommand(command), false, command);
    assert.notEqual(verification([user, edit("app.ts"), run(command, "succeeded", 0)]).state, "verified", command);
    assert.notEqual(verification([user, edit("app.ts"), run("pnpm test", "succeeded", 0), run(command, "succeeded", 0)]).state, "verified", command);
  }
  for (const command of ["pnpm build && pnpm test", "cd pkg && npm test", "pnpm test --filter 'name;with|operators'", "bash -c 'pnpm build && pnpm test'"]) {
    assert.equal(isCheckCommand(command), true, command);
    assert.equal(verification([user, edit("app.ts"), run(command, "succeeded", 0)]).state, "verified", command);
  }
});

test("dynamic shell expansion and write-capable read commands invalidate earlier verification", () => {
  for (const command of ['echo "$(touch app.ts)"', "echo `touch app.ts`", "cat <(node rewrite.js)",
    "env node rewrite.js", "sort -o app.ts input.txt", "uniq input.txt app.ts", "sed -n 'w app.ts' input.txt",
    "git diff --output=app.ts", "git branch new", "git remote add upstream https://example.com/repo",
    "find . -fprint app.ts", "rg --pre ./rewrite.js pattern .", "tree -o app.ts",
  ]) {
    assert.equal(verification([user, edit("app.ts"), run("pnpm test", "succeeded", 0), run(command, "succeeded", 0)]).state, "stale", command);
  }
});

test("a turn is verified only when every check after its last change passed", () => {
  assert.deepEqual(verification([user, edit("a.ts"), run("pnpm test", "succeeded", 0)]).state, "verified");
  const v = verification([user, edit("a.ts"), run("pnpm test", "succeeded")]);
  assert.equal(v.state, "verified", "Claude Code reports no exit code; a command that failed comes through as failed");
  assert.deepEqual(v.checks.map((c) => [c.command, c.passed, c.stale]), [["pnpm test", true, false]]);
});

test("model prose and an unrelated exit-zero command do not verify anything", () => {
  const items = [user, edit("a.ts"), run("echo ok", "succeeded", 0), { id: "A", kind: "assistant", text: "All tests pass.", phase: "final", outcome: "succeeded", at: at(99) } as ThreadItem];
  assert.deepEqual(verification(items), { state: "none", checks: [], edits: 1 });
});

test("a failed, denied, stopped or unreported check does not verify; a nonzero exit is a failure", () => {
  assert.equal(verification([user, edit("a.ts"), run("pnpm test", "failed", 1)]).state, "failed");
  assert.equal(verification([user, edit("a.ts"), run("pnpm test", "denied", null)]).state, "failed");
  assert.equal(verification([user, edit("a.ts"), run("pnpm test", "succeeded", 2)]).state, "failed", "the exit code wins over a success label");
  assert.equal(verification([user, edit("a.ts"), run("pnpm test", "interrupted")]).state, "unknown");
  assert.equal(verification([user, edit("a.ts"), run("pnpm test", "unknown")]).state, "unknown");
  assert.equal(verification([user, edit("a.ts"), run("pnpm test", "succeeded", null)]).state, "unknown", "the CLI said there is no exit code");
  assert.equal(verification([user, edit("a.ts"), run("pnpm test", "succeeded", 0), run("pnpm lint", "failed", 1)]).state, "failed", "every check after the change must pass");
});

test("a later edit, or a later command that might write, makes earlier checks stale; a denied edit and read-only commands do not", () => {
  assert.equal(verification([user, run("pnpm test", "succeeded", 0), edit("a.ts")]).state, "stale");
  assert.equal(verification([user, edit("a.ts"), run("pnpm test", "succeeded", 0), run("npm install", "succeeded", 0)]).state, "stale", "Modex cannot see what an unknown command wrote");
  assert.equal(verification([user, edit("a.ts"), run("pnpm test", "succeeded", 0), edit("b.ts", "denied")]).state, "verified");
  assert.equal(verification([user, edit("a.ts"), run("pnpm test", "succeeded", 0), run("git status --short", "succeeded", 0), run("cat a.ts", "succeeded", 0)]).state, "verified");
  assert.equal(verification([user, edit("a.ts"), run("pnpm test", "succeeded", 0), run("echo done > log.txt", "succeeded", 0)]).state, "stale", "a redirect writes");
  // The usual repair loop: a failing check, a fix, then a passing check. The failure is stale; the pass verifies.
  const repaired = verification([user, edit("a.ts"), run("pnpm test", "failed", 1), edit("a.ts"), run("pnpm test", "succeeded", 0)]);
  assert.equal(repaired.state, "verified");
  assert.deepEqual(repaired.checks.map((c) => [c.passed, c.stale]), [[false, true], [true, false]]);
});

test("the note says what verified the turn, marks stale checks, and lists anything short of verified as not settled", () => {
  const verified = taskMarkdown(taskRecord([user, edit("a.ts"), run("pnpm test", "failed", 1), edit("a.ts"), run("pnpm test", "succeeded", 0)], { threadId: "T", title: "Fix the import", cwd: "/repo" }));
  assert.match(verified, /## Verification\n\nVerified: every check after the turn's last change passed\.\n\n- `pnpm test` — failed, exit code 1 \(ran before a later change\)\n- `pnpm test` — succeeded, exit code 0\n/);
  assert.doesNotMatch(verified, /Not verified/);
  const stale = taskMarkdown(taskRecord([user, run("pnpm test", "succeeded", 0), edit("a.ts")], { threadId: "T", title: "Fix", cwd: "/repo" }));
  assert.match(stale, /Not verified: every check ran before a later change\./);
  assert.match(stale, /## Not settled\n\n- Not verified: every check ran before a later change\./);
  const none = taskMarkdown(taskRecord([user, edit("a.ts")], { threadId: "T", title: "Fix", cwd: "/repo" }));
  assert.match(none, /## Not settled\n\n- Not verified: no check result confirms the latest changes\./);
  const chat = taskMarkdown(taskRecord([user, { id: "A", kind: "assistant", text: "It is in config.ts.", phase: "final", outcome: "succeeded", at: at(99) } as ThreadItem], { threadId: "T", title: "Where", cwd: "/repo" }));
  assert.doesNotMatch(chat, /Verification|Not verified/, "a turn that changed nothing and ran no check has nothing to verify");
});

test("a check is shown as the script its shell ran; the exact command stays the record", () => {
  assert.equal(displayCommand("/bin/zsh -lc 'pnpm test'"), "pnpm test");
  assert.equal(displayCommand("bash -c \"cd pkg && npm test\""), "cd pkg && npm test");
  assert.equal(displayCommand("pnpm test"), "pnpm test");
  assert.equal(displayCommand("/bin/zsh -lc 'pnpm test' && echo done"), "/bin/zsh -lc 'pnpm test' && echo done", "only a whole-command wrapper is unwrapped");
  assert.equal(verification([user, edit("a.ts"), edit("b.ts", "denied")]).edits, 1, "a denied edit changed nothing");
});

// The context map (CF-7 #280): the project files a turn touched, by what the CLI reported.
const tool = (name: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}): ThreadItem =>
  ({ id: `t${++seqId}`, kind: "tool", name, title: name, args, status: "done", outcome: "succeeded", ok: true, at: at(seqId), ...extra }) as ThreadItem;
const codexRun = (command: string, actions: unknown[]): ThreadItem =>
  ({ id: `t${++seqId}`, kind: "tool", name: "shell", title: `$ ${command}`, args: { command }, status: "done", outcome: "succeeded", ok: true, exec: { command, actions }, exitCode: 0, at: at(seqId) }) as ThreadItem;

test("the context map lists the files a turn changed, read and searched, as each CLI reported them", () => {
  const context = taskContext([
    user,
    tool("Read", { file_path: "/repo/src/config.ts" }),
    tool("Grep", { pattern: "import", path: "/repo/src" }),
    tool("Glob", { pattern: "**/*.test.ts", path: "/repo/test" }),
    tool("Edit", { file_path: "/repo/src/config.ts", old_string: "a", new_string: "b" }),
    // Stored as main keeps Codex's commandActions (codexActions): an unknown action is not kept.
    codexRun("sed -n 1,40p src/app.ts", [{ kind: "read", path: "src/app.ts" }]),
    codexRun("rg -n useEffect src", [{ kind: "search", path: "src", query: "useEffect" }]),
    codexRun("ls docs", [{ kind: "list", path: "docs" }]),
    codexRun("make", []),
    { id: `t${++seqId}`, kind: "tool", name: "apply_patch", title: "edit src/app.ts, README.md", args: {}, status: "done", outcome: "succeeded", ok: true, at: at(seqId) } as ThreadItem,
    tool("read_file", { path: "package.json" }),
    tool("list_dir", { path: "." }),
    tool("write_file", { path: "NOTES.md", content: "x" }),
  ], "/repo");
  assert.deepEqual(context.files, [
    { path: "src/config.ts", relations: ["read", "changed"] },
    { path: "src/app.ts", relations: ["read", "changed"] },
    { path: "README.md", relations: ["changed"] },
    { path: "NOTES.md", relations: ["changed"] },
    { path: "package.json", relations: ["read"] },
    { path: "src", relations: ["searched"] },
    { path: "test", relations: ["searched"] },
    { path: "docs", relations: ["searched"] },
    { path: ".", relations: ["searched"] },
  ]);
  assert.equal(context.outside, 0);
});

test("denied and failed tools touched nothing; paths outside the project are counted, never named", () => {
  const context = taskContext([
    user,
    tool("Read", { file_path: "/repo/secret.ts" }, { outcome: "denied", ok: false }),
    tool("Read", { file_path: "/repo/missing.ts" }, { outcome: "failed", ok: false }),
    tool("Edit", { file_path: "/repo/a.ts" }, { outcome: "denied", ok: false }),
    tool("Read", { file_path: "/Users/someone/.ssh/config" }),
    tool("read_file", { path: "../other-project/x.ts" }),
    codexRun("cat /etc/hosts", [{ kind: "read", path: "/etc/hosts" }]),
    tool("Read", { file_path: "/repo/kept.ts" }),
  ], "/repo");
  assert.deepEqual(context.files, [{ path: "kept.ts", relations: ["read"] }]);
  assert.equal(context.outside, 3);
});

test("the note lists at most the first files the turn touched, says how many more, and nothing for a turn that touched none", () => {
  const many = [user, ...Array.from({ length: CONTEXT_SHOWN + 5 }, (_, i) => tool("Read", { file_path: `/repo/src/f${i}.ts` }))];
  const note = taskMarkdown(taskRecord(many, { threadId: "T", title: "Read a lot", cwd: "/repo" }));
  assert.match(note, /## Files the turn touched\n\nAs the CLI reported them\. Modex did not index the project\.\n\n- `src\/f0\.ts` — read\n/);
  assert.equal((note.match(/^- `src\/f\d+\.ts` — read$/gm) ?? []).length, CONTEXT_SHOWN);
  assert.match(note, /- and 5 more\n/);
  const none = taskMarkdown(taskRecord([user, { id: "A", kind: "assistant", text: "Hi.", phase: "final", outcome: "succeeded", at: at(99) } as ThreadItem], { threadId: "T", title: "Hi", cwd: "/repo" }));
  assert.doesNotMatch(none, /Files the turn touched/);
});


// CF-7 close-out observations 1 and 2 (docs/reviews/2026-10-29-cf7-closeout): a file a shell command wrote
// without any CLI naming it must not leave the map looking complete.
const bash = (command: string, extra: Record<string, unknown> = {}): ThreadItem =>
  ({ id: `t${++seqId}`, kind: "tool", name: "Bash", title: `$ ${command}`, args: { command }, status: "done", outcome: "succeeded", ok: true, exec: { command }, at: at(seqId), ...extra }) as ThreadItem;

test("a Claude shell redirect that rewrote a file read earlier is listed as a command that may have changed files", () => {
  const redirect = "printf 'hello, live\\n' > greeting.txt && cat greeting.txt";
  const items = [user, bash("npm test", { outcome: "failed", ok: false }), tool("Read", { file_path: "/repo/greeting.txt" }), bash(redirect), bash("npm test")];
  const context = taskContext(items, "/repo");
  assert.deepEqual(context.files, [{ path: "greeting.txt", relations: ["read"] }], "Claude reported only the Read; Modex does not guess the redirect's file");
  assert.deepEqual(context.unlisted, [redirect]);
  assert.equal(contextCount(context), "1, maybe more");
  const note = taskMarkdown(taskRecord(items, { threadId: "T", title: "Say hello, live", cwd: "/repo" }));
  assert.ok(note.includes(`- \`greeting.txt\` — read\n\n${UNLISTED_WORDS}\n\n- \`${redirect}\`\n`), note);
});

test("a Codex in-place edit it parsed as unknown still gives the note a files section, listing the command once", () => {
  const perl = "/bin/zsh -lc 'perl -pi -e '\"'\"'s/\\bhello\\b/hello, live/g'\"'\"' greeting.txt'";
  const items = [user, codexRun("/bin/zsh -lc 'npm test'", []), codexRun(perl, []), codexRun(perl, []), codexRun("/bin/zsh -lc 'npm test'", [])];
  const context = taskContext(items, "/repo");
  assert.deepEqual(context.files, []);
  assert.deepEqual(context.unlisted, [perl], "the same command run twice is listed once");
  assert.equal(contextCount(context), "not listed");
  const note = taskMarkdown(taskRecord(items, { threadId: "T", title: "Say hello, live", cwd: "/repo" }));
  assert.match(note, /## Files the turn touched\n\nAs the CLI reported them\. Modex did not index the project\.\n\nThese commands may have changed files/);
  assert.ok(note.includes(`- \`${perl.replace(/`/g, "'")}\`\n`));
});

test("checks, read-only commands, and denied or failed commands are not listed as possible writers", () => {
  const context = taskContext([
    user,
    bash("pnpm test"),
    bash("cat a.txt && sed -n 1,5p b.txt | wc -l"),
    bash("git status --short"),
    bash("rm -rf build", { outcome: "denied", ok: false }),
    bash("touch x", { outcome: "failed", ok: false }),
    tool("Edit", { file_path: "/repo/a.ts", old_string: "a", new_string: "b" }),
  ], "/repo");
  assert.equal(context.unlisted, undefined);
  assert.equal(contextCount(context), "1");
  // An interrupted or unreported command may still have written something.
  assert.deepEqual(taskContext([bash("git checkout -- a.ts", { outcome: "interrupted" }), bash("echo x > out.txt", { outcome: "unknown", ok: undefined })], "/repo").unlisted,
    ["git checkout -- a.ts", "echo x > out.txt"]);
});

test("the note lists at most the first possible-writer commands and says how many more", () => {
  const items = [user, ...Array.from({ length: CONTEXT_SHOWN + 2 }, (_, i) => bash(`touch f${i}`))];
  const note = taskMarkdown(taskRecord(items, { threadId: "T", title: "Touch", cwd: "/repo" }));
  assert.equal((note.match(/^- `touch f\d+`$/gm) ?? []).length, CONTEXT_SHOWN);
  assert.match(note, /- and 2 more\n/);
});

test("a saved record from before possible writers were listed still reopens; a damaged list does not", () => {
  const record = taskRecord([user, tool("Read", { file_path: "/repo/a.ts" })], { threadId: "T", title: "Read", cwd: "/repo" });
  const snapshot = (context: unknown) => ({ version: 1, pageId: "P", revision: 1, projectId: "p", threadId: "T", turnId: "U", savedAt: at(1), record: { ...record, context } });
  assert.equal(isTaskSnapshot(snapshot({ files: [{ path: "a.ts", relations: ["read"] }], outside: 0 })), true);
  assert.equal(isTaskSnapshot(snapshot({ files: [], outside: 0, unlisted: ["make"] })), true);
  assert.equal(isTaskSnapshot(snapshot({ files: [], outside: 0, unlisted: [42] })), false);
});

test("Codex context actions resolve from the command cwd before project containment", () => {
  const run = (cwd: string, path: string): ThreadItem => {
    const item = codexRun("cat file", [{ kind: "read", path }]);
    if (item.kind === "tool" && item.exec) item.exec.cwd = cwd;
    return item;
  };
  const context = taskContext([
    run("/repo/src", "app.ts"),
    run("/private", "private.txt"),
    run("/repo/src", "../README.md"),
  ], "/repo");
  assert.deepEqual(context.files, [
    { path: "src/app.ts", relations: ["read"] },
    { path: "README.md", relations: ["read"] },
  ]);
  assert.equal(context.outside, 1);
});

test("context paths normalize dot segments before checking project boundaries", () => {
  const context = taskContext([
    tool("Read", { file_path: "/repo/../private/key" }),
    tool("Read", { file_path: "/repo/src/../kept.ts" }),
    tool("Read", { file_path: "./kept.ts" }),
    tool("Read", { file_path: "/repo-other/key" }),
    tool("Read", { file_path: "file..txt" }),
  ], "/repo");
  assert.deepEqual(context.files, [
    { path: "kept.ts", relations: ["read"] },
    { path: "file..txt", relations: ["read"] },
  ]);
  assert.equal(context.outside, 2);
});


test("Windows context paths normalize separators, command cwd and traversal", () => {
  const item = codexRun("type app.ts", [{ kind: "read", path: "app.ts" }]);
  if (item.kind === "tool" && item.exec) item.exec.cwd = "C:\\repo\\src";
  const context = taskContext([
    item,
    tool("Read", { file_path: "C:\\repo\\..\\private\\key" }),
    tool("Read", { file_path: "C:\\repo\\src\\..\\README.md" }),
    tool("Read", { file_path: "D:\\repo\\other.ts" }),
  ], "C:\\repo");
  assert.deepEqual(context.files, [
    { path: "src/app.ts", relations: ["read"] },
    { path: "README.md", relations: ["read"] },
  ]);
  assert.equal(context.outside, 2);
});

test("absolute project root and normalized cwd retain project listing", () => {
  assert.deepEqual(taskContext([tool("LS", { path: "/repo" })], "/repo/src/..").files,
    [{ path: ".", relations: ["searched"] }]);
});


test("Windows drive-relative paths stay unnamed and rooted paths inherit the drive", () => {
  const context = taskContext([
    tool("Read", { file_path: "C:..\\private\\key" }),
    tool("Read", { file_path: "\\repo\\app.ts" }),
  ], "C:\\repo");
  assert.deepEqual(context.files, [{ path: "app.ts", relations: ["read"] }]);
  assert.equal(context.outside, 1);
});

test("UNC share roots retain files with or without a trailing separator", () => {
  for (const cwd of ["\\\\server\\share", "\\\\server\\share\\"]) {
    assert.deepEqual(taskContext([tool("Read", { file_path: "file.ts" })], cwd), {
      files: [{ path: "file.ts", relations: ["read"] }], outside: 0,
    });
  }
});

test("external file counts use resolved identities without exposing paths", () => {
  const run = (cwd: string, path: string): ThreadItem => {
    const item = codexRun("cat file", [{ kind: "read", path }]);
    if (item.kind === "tool" && item.exec) item.exec.cwd = cwd;
    return item;
  };
  assert.deepEqual(taskContext([run("/private-a", "secret.txt"), run("/private-b", "secret.txt")], "/repo"), { files: [], outside: 2 });
  const aliases = [run("/private", "secret.txt"), run("/private", "/private/secret.txt"), run("/private", "/private/sub/../secret.txt")];
  assert.deepEqual(taskContext(aliases, "/repo"), { files: [], outside: 1 });
  assert.doesNotMatch(taskMarkdown(taskRecord([user, ...aliases], { threadId: "T", title: "Read", cwd: "/repo" })), /private|secret/);
});

test("a finished turn that did work without a plan says which CLI reported none; a chat turn or a planned turn does not", () => {
  const at = "2026-10-23T09:00:00.000Z";
  const origin = (backend: "claude" | "codex") => ({ thread: "T", turn: "u1", attempt: "A1", backend, native: { runtime: "R", item: "x" } });
  const turn = (backend: "claude" | "codex", extra: ThreadItem[] = []): ThreadItem[] => [
    { id: "u1", kind: "user", text: "Fix the import", at },
    { id: "e", kind: "tool", name: "Edit", title: "edit src/a.ts", args: { file_path: "/repo/src/a.ts" }, status: "done", outcome: "succeeded", ok: true, origin: origin(backend), at },
    ...extra,
    { id: "f", kind: "assistant", text: "Fixed.", phase: "final", outcome: "succeeded", origin: origin(backend), at },
  ] as ThreadItem[];
  const md = (items: ThreadItem[]) => taskMarkdown(taskRecord(items, { threadId: "T", title: "Fix", cwd: "/repo" }));
  assert.equal(noPlan(turn("claude")), "claude");
  assert.ok(md(turn("claude")).includes("## Plan\n\nClaude Code reported no plan for this turn.\n"), md(turn("claude")));
  assert.equal(noPlan(turn("codex")), "codex");
  assert.ok(md(turn("codex")).includes("Codex reported no plan for this turn."));
  const chat = [{ id: "u1", kind: "user", text: "Where?", at }, { id: "f", kind: "assistant", text: "In a.ts.", phase: "final", outcome: "succeeded", origin: origin("claude"), at }] as ThreadItem[];
  assert.equal(noPlan(chat), null, "a turn that changed and ran nothing has nothing to plan");
  assert.ok(!md(chat).includes("## Plan"));
  const planned = turn("claude", [{ id: "p", kind: "plan", from: "claude-todo", revision: 1, steps: [{ text: "Fix", status: "completed" }], outcome: "succeeded", origin: origin("claude"), at } as ThreadItem]);
  assert.equal(noPlan(planned), null);
  assert.ok(!md(planned).includes("reported no plan"));
});
