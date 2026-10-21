import { test } from "node:test";
import assert from "node:assert/strict";
import { CONVERSATION_SCHEMA, projectConversation, type ConversationEvent, type Observation, type AttemptMark, type TurnRef } from "../src/shared/conversation-events.js";
import { CONTEXT_SHOWN, displayCommand, isCheckCommand, taskContext, taskRecord, taskMarkdown, verification } from "../src/shared/task-context.js";
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
  assert.match(none, /## Not settled\n\n- Not verified: no check ran after the turn's changes\./);
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
