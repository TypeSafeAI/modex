import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
import { ClaudeBackend, TaskList } from "../src/main/engine/backends/claude.js";
import { taskRecord, taskMarkdown } from "../src/shared/task-context.js";
import type { ThreadEvent, ThreadItem } from "../src/shared/types.js";
import { FakeProcess, fakeSpawn } from "./fakeproc.js";
import { gitRepo, tmpdir } from "./helpers.js";

/**
 * A live Claude Code 2.1.309 turn with `TaskCreate`/`TaskUpdate`, replayed through the Claude backend
 * and the runner (docs/task-context.md#plans). The fixture is a redacted capture; `/repo` stands for
 * the capture's project.
 */

type Line = { dir: "in" | "out"; msg: Record<string, unknown> };
function capture(name: string, cwd: string): Line[] {
  const text = fs.readFileSync(fileURLToPath(new URL(`../../test/fixtures/${name}`, import.meta.url)), "utf8").replaceAll("/repo", cwd);
  return text.trim().split("\n").slice(1).map((l) => JSON.parse(l) as Line);
}

test("live Claude Code (2.1.309) task tools: the tasks it created and updated are the turn's plan, and the one it left in progress is not reported done", async () => {
  const proc = new FakeProcess();
  const claude = new ClaudeBackend("claude", fakeSpawn(proc).spawn);
  const home = tmpdir("modex-live-");
  const store = new Store(home);
  const events: ThreadEvent[] = [];
  const runner = new ThreadRunner({ home, store, emit: (e) => events.push(e), backends: { claude } });
  const project = store.addProject(gitRepo());
  const thread = await runner.createThread(project.id, { backend: "claude", auto: false });
  const lines = capture("claude-tasks-2.1.309.jsonl", project.path);
  assert.ok((lines.find((l) => l.msg.subtype === "init")!.msg.tools as string[]).includes("TaskCreate"), "the capture offered TaskCreate");
  // Once Modex sends the turn, the CLI's side plays in order; this turn needed no permission answers.
  let played = false;
  proc.stdin.on("data", (d: Buffer) => {
    if (played || !d.toString().includes('"type":"user"')) return;
    played = true;
    setImmediate(() => { for (const l of lines) if (l.dir === "in") proc.emitLine(l.msg); });
  });
  try {
    await runner.send(thread.id, "Write the greeting");
    const items = runner.items(thread.id);
    const plans = items.filter((i) => i.kind === "plan") as (ThreadItem & { kind: "plan" })[];
    assert.equal(plans.length, 1, "one plan, revised by each confirmed call");
    const plan = plans[0]!;
    assert.equal(plan.from, "claude-tasks");
    assert.deepEqual(plan.steps, [
      { text: "Write Hello to greeting.txt", status: "completed" },
      { text: "Run node check.js", status: "in-progress" },
      { text: "Reply in one sentence", status: "completed" },
    ], "as Claude left them: it never marked task #2 completed after node check.js failed");
    assert.equal(plan.revision, 8, "three creates and five updates");

    const record = taskRecord(items, { threadId: thread.id, title: "Greeting", cwd: project.path });
    assert.equal(record.noPlan, undefined);
    assert.deepEqual(record.plan?.steps.map((s) => s.status), ["completed", "in-progress", "completed"]);
    const md = taskMarkdown(record);
    assert.ok(md.includes("- [ ] Run node check.js (in progress)"), md);
    assert.ok(md.includes("From Claude's task list, revision 8."), md);
    assert.ok(record.commands.some((c) => c.command === "node check.js" && c.outcome === "failed"), "the failed check is still the command that failed");
  } finally { await runner.dispose(); await claude.dispose(); }
});

test("Claude's task list counts a call only once its result confirms it, and never guesses a task it did not see created", () => {
  const list = new TaskList();
  list.called("a", "TaskCreate", { subject: "Write it", description: "" });
  assert.equal(list.confirmed("a", "Error: something else"), undefined, "a result without a task id creates nothing");
  list.called("b", "TaskCreate", { subject: "Write it", description: "" });
  assert.deepEqual(list.confirmed("b", "Task #4 created successfully: Write it"), [{ text: "Write it", status: "pending" }]);
  list.called("c", "TaskUpdate", { taskId: "9", status: "completed" });
  assert.equal(list.confirmed("c", "Updated task #9 status"), undefined, "task #9 was created in an earlier turn");
  list.called("d", "TaskUpdate", { taskId: "4", status: "in_progress", subject: "Write it twice" });
  assert.deepEqual(list.confirmed("d", "Updated task #4 status"), [{ text: "Write it twice", status: "in-progress" }]);
  assert.equal(list.confirmed("unknown", "Task #5 created"), undefined, "a result for a call Modex never saw");
  list.called("e", "TaskUpdate", { taskId: "4", status: "deleted" });
  assert.deepEqual(list.confirmed("e", "Updated task #4 deleted"), []);
});
