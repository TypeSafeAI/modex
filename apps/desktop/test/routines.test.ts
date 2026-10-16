import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { MISSED_AFTER_MS, nextDue, RoutinePages, RoutineScheduler, ROUTINES_FOLDER, validateRoutine, type RoutineHost } from "../src/main/engine/routines.js";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
import { ClaudeBackend } from "../src/main/engine/backends/claude.js";
import { CodexBackend } from "../src/main/engine/backends/codex.js";
import type { Backend, TurnOptions, TurnResult, TurnSink } from "../src/main/engine/backends/types.js";
import type { ApprovalAnswer, BackendId, ThreadItem } from "../src/shared/types.js";
import type { RoutineDraft, RoutineRun } from "../src/shared/routines.js";
import { gitRepo, tmpdir } from "./helpers.js";

const HOUR = 60 * 60_000;
const T0 = Date.parse("2026-10-15T09:00:30.000Z");

/** A CLI stand-in: records each turn's options, asks for one approval, then replies (or waits). */
class FakeCli implements Backend {
  readonly turns: TurnOptions[] = [];
  readonly answers: ApprovalAnswer[] = [];
  release?: () => void;
  constructor(readonly id: BackendId, private readonly behave: { reply?: string; hold?: boolean; fail?: string; partial?: string; stubborn?: boolean } = {}) {}
  async runTurn(_text: string, opts: TurnOptions, sink: TurnSink, signal: AbortSignal): Promise<TurnResult> {
    this.turns.push(opts);
    this.answers.push(await sink.approval({ question: "Run `ls`?", canAlways: false, action: { backend: this.id, tool: "Bash", title: "$ ls", cwd: opts.cwd } }));
    if (this.behave.partial) sink.delta(this.behave.partial);
    if (this.behave.hold) await new Promise<void>((resolve) => { this.release = resolve; if (!this.behave.stubborn) signal.addEventListener("abort", () => resolve(), { once: true }); });
    if (signal.aborted) return { status: "interrupted" };
    if (this.behave.fail) return { status: "failed", error: this.behave.fail };
    sink.assistant(this.behave.reply ?? "Nothing changed overnight.");
    return { status: "completed" };
  }
  async listModels() { return []; }
  async dispose() {}
}

function fixture(backends: Partial<Record<BackendId, Backend>> = {}, now = () => T0, home = tmpdir("modex-routines-"), limits: { runTimeoutMs?: number; stopGraceMs?: number } = {}) {
  const store = new Store(home);
  const project = store.snapshot().projects[0] ?? store.addProject(gitRepo());
  const runner = new ThreadRunner({ home, store, emit: () => {}, backends: { mock: new FakeCli("mock"), ...backends } });
  const ended: RoutineRun[] = [];
  const host: RoutineHost = {
    project: (id) => store.project(id),
    createThread: (projectId, routine) => runner.createRoutineThread(projectId, routine),
    sendUnattended: (id, text) => runner.sendUnattended(id, text),
    stop: (id) => runner.stop(id),
    items: (id) => runner.items(id),
    status: (id) => runner.status(id),
    addNotice: (id, level, text) => runner.addNotice(id, level, text),
    pages: new RoutinePages(store.space),
    runEnded: (run) => ended.push(run),
  };
  const scheduler = new RoutineScheduler(home, host, now, limits);
  return { home, store, project, runner, scheduler, ended, host };
}

const draft = (projectId: string, over: Partial<RoutineDraft> = {}): RoutineDraft => ({
  name: "Nightly review", projectId, instructions: "Summarize what changed since yesterday.", mode: "chat", backend: "mock", enabled: true,
  trigger: { kind: "interval", every: 1, unit: "hours", from: "2026-10-15T08:00:00.000Z" }, ...over,
});

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 500 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), what);
}

test("due times sit on the trigger's grid, and a one-time trigger is due once", () => {
  const every = { kind: "interval", every: 2, unit: "hours", from: "2026-10-15T08:00:00.000Z" } as const;
  assert.equal(new Date(nextDue(every, Date.parse("2026-10-15T07:00:00Z"))!).toISOString(), "2026-10-15T08:00:00.000Z");
  assert.equal(new Date(nextDue(every, Date.parse("2026-10-15T08:00:00Z"))!).toISOString(), "2026-10-15T10:00:00.000Z");
  assert.equal(new Date(nextDue(every, Date.parse("2026-10-16T09:59:00Z"))!).toISOString(), "2026-10-16T10:00:00.000Z");
  assert.equal(nextDue({ kind: "once", at: "2026-10-15T08:00:00.000Z" }, Date.parse("2026-10-15T08:00:00Z")), null);
});

test("only read-only routines can be saved", () => {
  const exists = (id: string) => id === "p";
  assert.deepEqual(validateRoutine({ ...draft("p"), name: "  Nightly review " }, exists).name, "Nightly review");
  for (const mode of ["agent", "full-access", undefined]) assert.throws(() => validateRoutine({ ...draft("p"), mode }, exists), /read-only: choose Chat or Plan/);
  assert.throws(() => validateRoutine({ ...draft("p"), trigger: { kind: "interval", every: 4, unit: "minutes", from: "2026-10-15T08:00:00Z" } }, exists), /every 5 minutes/);
  assert.throws(() => validateRoutine(draft("missing"), exists), /Choose a project/);
  assert.throws(() => validateRoutine({ ...draft("p"), instructions: " " }, exists), /Instructions/);
  assert.throws(() => validateRoutine({ ...draft("p"), backend: "gpt" }, exists), /valid provider/);
});

test("a due routine runs read-only, writes its page under Routines, and Activity records the run", async () => {
  let now = T0;
  const f = fixture({}, () => now);
  try {
    f.scheduler.start();
    const routine = f.scheduler.save(draft(f.project.id));
    assert.equal(routine.nextRunAt, "2026-10-15T10:00:00.000Z", "the next grid point after now");
    now = Date.parse("2026-10-15T10:00:10.000Z");
    f.scheduler.tick();
    await until(() => f.ended.length === 1, "the first run ends");
    const [run] = f.scheduler.list().runs;
    assert.partialDeepStrictEqual(run, { routineName: "Nightly review", trigger: "schedule", scheduledFor: "2026-10-15T10:00:00.000Z", status: "completed", startedAt: "2026-10-15T10:00:10.000Z", endedAt: "2026-10-15T10:00:10.000Z" });
    assert.equal(run!.page!.revision, 1);
    const thread = f.store.thread(run!.threadId!)!;
    assert.deepEqual([thread.mode, thread.plan, thread.title, thread.routine], ["chat", false, "Nightly review", { id: routine.id, name: "Nightly review", runId: run!.id }]);
    const page = f.store.space.list().find((p) => p.id === run!.page!.id)!;
    assert.match(page.markdown, /^Nothing changed overnight\.\n\n---\n\n\*Written by the routine “Nightly review”: scheduled run/);
    const tree = f.store.space.tree().nodes;
    const folder = tree.find((node) => node.kind === "folder" && node.name === ROUTINES_FOLDER)!;
    assert.equal(tree.find((node) => node.id === folder.parentId)?.kind, "project", "the folder sits in the project's own notes");
    const items = f.runner.items(thread.id);
    assert.ok(items.some((item) => item.kind === "notice" && /scheduled run · read-only Chat/.test(item.text)), "the transcript says what ran it");
    assert.ok(items.some((item) => item.kind === "notice" && item.text === `Saved to the Space page “Nightly review”, revision 1.`));
    assert.equal(f.scheduler.list().routines[0]!.nextRunAt, "2026-10-15T11:00:00.000Z");
    assert.equal(f.scheduler.list().routines[0]!.pageId, page.id);
  } finally { f.scheduler.dispose(); await f.runner.dispose(); }
});

test("missed due times run once when noticed, never as a burst, and later runs add revisions to the same page", async () => {
  let now = T0;
  const f = fixture({}, () => now);
  try {
    f.scheduler.start();
    f.scheduler.save(draft(f.project.id));
    now = Date.parse("2026-10-15T10:00:05.000Z");
    f.scheduler.tick();
    await until(() => f.ended.length === 1, "the first run ends");
    // Asleep from 10:00 to 13:30: 11:00, 12:00 and 13:00 all passed.
    now = Date.parse("2026-10-15T13:30:00.000Z");
    f.scheduler.tick();
    f.scheduler.tick();
    await until(() => f.ended.length === 2, "the missed run ends");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const runs = f.scheduler.list().runs;
    assert.equal(runs.length, 2, "one run for three missed due times");
    assert.partialDeepStrictEqual(runs[0], { trigger: "missed", scheduledFor: "2026-10-15T11:00:00.000Z", status: "completed", page: { revision: 2 } });
    assert.equal(runs[0]!.page!.id, runs[1]!.page!.id, "each run is a new revision of the routine's page");
    assert.ok(Date.parse("2026-10-15T13:30:00.000Z") - Date.parse(runs[0]!.scheduledFor!) > MISSED_AFTER_MS);
    assert.equal(f.scheduler.list().routines[0]!.nextRunAt, "2026-10-15T14:00:00.000Z");
    assert.deepEqual(f.store.space.history(runs[0]!.page!.id).map((v) => v.summary), [`Routine run ${runs[1]!.id}`, `Routine run ${runs[0]!.id}`]);
  } finally { f.scheduler.dispose(); await f.runner.dispose(); }
});

test("killed mid-run: the next start marks the run interrupted, writes no page and does not run it again", async () => {
  const cli = new FakeCli("mock", { hold: true });
  const first = fixture({ mock: cli });
  first.scheduler.start();
  const routine = first.scheduler.save(draft(first.project.id, { trigger: { kind: "interval", every: 1, unit: "days", from: "2026-10-16T08:00:00.000Z" } }));
  await first.scheduler.runNow(routine.id);
  await until(() => Boolean(first.scheduler.list().runs[0]?.threadId) && cli.turns.length === 1, "the turn is working");
  // The process dies here: no dispose, no finish. A new Modex starts on the same home.
  const second = fixture({}, () => T0 + HOUR, first.home);
  try {
    second.scheduler.start();
    const [run] = second.scheduler.list().runs;
    assert.partialDeepStrictEqual(run, { status: "interrupted", error: "Modex quit while this run was working." });
    assert.equal(run!.page, undefined);
    assert.equal(second.store.space.list().length, 0, "no page revision");
    assert.equal(second.scheduler.list().runs.length, 1, "an interrupted run is never re-run");
    assert.equal(second.scheduler.list().routines[0]!.nextRunAt, routine.nextRunAt, "a manual run leaves the schedule alone");
  } finally {
    second.scheduler.dispose();
    first.scheduler.dispose();
    cli.release?.();
    await second.runner.dispose();
    await first.runner.dispose();
  }
});

test("a run whose page was written before Modex died is recovered as completed, never written twice", async () => {
  const f = fixture();
  const routine = { ...draft(f.project.id), id: "11111111-2222-3333-4444-555555555555", createdAt: "", updatedAt: "", nextRunAt: null };
  const run: RoutineRun = { id: "66666666-7777-8888-9999-000000000000", routineId: routine.id, routineName: routine.name, projectId: f.project.id, trigger: "schedule", startedAt: new Date(T0).toISOString(), status: "running" };
  fs.mkdirSync(path.join(f.home, "app"), { recursive: true });
  fs.writeFileSync(path.join(f.home, "app", "routines.json"), JSON.stringify({ version: 1, routines: [routine], runs: [run] }));
  const written = f.host.pages.write(routine, run, f.project, "Written just before the crash.");
  const scheduler = new RoutineScheduler(f.home, f.host, () => T0);
  try {
    scheduler.start();
    assert.partialDeepStrictEqual(scheduler.list().runs[0], { status: "completed", page: written });
    assert.equal(scheduler.list().routines[0]!.pageId, written.id);
    assert.deepEqual(f.host.pages.write(routine, run, f.project, "Again?"), written, "the run is its own idempotency key");
    assert.equal(f.store.space.history(written.id).length, 1);
  } finally { scheduler.dispose(); await f.runner.dispose(); }
});

test("the fence: a routine deleted, or Modex quitting, mid-run leaves it interrupted with no page", async () => {
  for (const cut of ["delete", "quit"] as const) {
    const cli = new FakeCli("mock", { hold: true });
    const f = fixture({ mock: cli });
    try {
      f.scheduler.start();
      const routine = f.scheduler.save(draft(f.project.id));
      await f.scheduler.runNow(routine.id);
      await until(() => cli.turns.length === 1, "the turn is working");
      if (cut === "delete") f.scheduler.remove(routine.id); else f.scheduler.dispose();
      cli.release?.();
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.partialDeepStrictEqual(f.scheduler.list().runs[0], { status: "interrupted", error: cut === "delete" ? "The routine was deleted while it ran." : "Modex quit while this run was working." });
      assert.equal(f.store.space.list().length, 0, `${cut}: no page`);
    } finally { f.scheduler.dispose(); await f.runner.dispose(); }
  }
});

test("a failed turn is a failed run with the CLI's reason and no page", async () => {
  const f = fixture({ mock: new FakeCli("mock", { fail: "codex exited with code 1" }) });
  try {
    f.scheduler.start();
    const routine = f.scheduler.save(draft(f.project.id));
    await f.scheduler.runNow(routine.id);
    await until(() => f.ended.length === 1, "the run ends");
    const [run] = f.scheduler.list().runs;
    assert.equal(run!.status, "failed");
    assert.equal(run!.trigger, "manual");
    assert.ok(run!.error, "the reason is kept");
    assert.equal(f.store.space.list().length, 0);
  } finally { f.scheduler.dispose(); await f.runner.dispose(); }
});

test("a routine's turns are read-only on both CLIs, and every approval is refused with a receipt", async () => {
  const claude = new FakeCli("claude"), codex = new FakeCli("codex");
  const f = fixture({ claude, codex });
  try {
    f.scheduler.start();
    const plan = f.scheduler.save(draft(f.project.id, { name: "Plan on Claude", backend: "claude", mode: "plan" }));
    const chat = f.scheduler.save(draft(f.project.id, { name: "Chat on Claude", backend: "claude", mode: "chat" }));
    const onCodex = f.scheduler.save(draft(f.project.id, { name: "Chat on Codex", backend: "codex", mode: "chat" }));
    const planOnCodex = f.scheduler.save(draft(f.project.id, { name: "Plan on Codex", backend: "codex", mode: "plan" }));
    for (const routine of [plan, chat, onCodex, planOnCodex]) await f.scheduler.runNow(routine.id);
    await until(() => f.ended.length === 4, "all four runs end");
    assert.deepEqual(f.scheduler.list().runs.map((run) => run.status), ["completed", "completed", "completed", "completed"]);

    const [planTurn, chatTurn] = claude.turns;
    assert.ok(ClaudeBackend.args(planTurn!).join(" ").includes("--permission-mode plan"));
    assert.ok(ClaudeBackend.args(chatTurn!).join(" ").includes("--permission-mode manual --disallowedTools Edit Write NotebookEdit"));
    for (const turn of claude.turns) assert.ok(!ClaudeBackend.args(turn).some((arg) => arg === "acceptEdits" || arg === "bypassPermissions"));
    for (const turn of codex.turns) {
      assert.deepEqual(CodexBackend.policy(turn).sandboxPolicy, { type: "readOnly", networkAccess: false });
      assert.equal(CodexBackend.policy(turn).sandbox, "read-only");
    }
    assert.deepEqual([...claude.answers, ...codex.answers], ["no", "no", "no", "no"], "nobody is there to approve anything");
    for (const run of f.scheduler.list().runs) {
      const card = f.runner.items(run.threadId!).find((item): item is Extract<ThreadItem, { kind: "approval" }> => item.kind === "approval")!;
      assert.equal(card.answer, "no");
      assert.equal(card.decidedBy?.ruleId, "policy:routine");
      assert.equal(card.decidedBy?.decision, "never");
    }
  } finally { f.scheduler.dispose(); await f.runner.dispose(); }
});

test("an unattended turn refuses a thread that is not read-only, and approvals reach a person again afterwards", async () => {
  const cli = new FakeCli("mock");
  const f = fixture({ mock: cli });
  try {
    const agent = await f.runner.createThread(f.project.id, { mode: "agent", backend: "mock" });
    await assert.rejects(f.runner.sendUnattended(agent.id, "go"), /must run in Chat/);
    assert.equal(cli.turns.length, 0, "nothing ran");
    const thread = await f.runner.createRoutineThread(f.project.id, { id: "r", name: "Check", runId: "run", plan: false, backend: "mock" });
    await f.runner.sendUnattended(thread.id, "look");
    assert.deepEqual(cli.answers, ["no"]);
    // The same thread with a person present: the approval waits for them again.
    const attended = f.runner.send(thread.id, "and now?");
    await until(() => f.runner.status(thread.id) === "waiting", "the approval waits for a person");
    const card = f.runner.items(thread.id).filter((item) => item.kind === "approval").at(-1)!;
    f.runner.answer(thread.id, card.id, "yes");
    await attended;
    assert.deepEqual(cli.answers, ["no", "yes"]);
  } finally { await f.runner.dispose(); }
});

test("an unreadable routines file is left alone and routines report it", () => {
  const home = tmpdir("modex-routines-");
  fs.mkdirSync(path.join(home, "app"), { recursive: true });
  fs.writeFileSync(path.join(home, "app", "routines.json"), "{ not json");
  const f = fixture({}, () => T0, home);
  f.scheduler.start();
  assert.match(f.scheduler.list().error!, /left as it is/);
  assert.throws(() => f.scheduler.save(draft(f.project.id)), /left as it is/);
  assert.equal(fs.readFileSync(path.join(home, "app", "routines.json"), "utf8"), "{ not json");
  f.scheduler.dispose();
});

test("the phone's snapshot lists ended runs without instructions or replies, and names routine threads", async () => {
  const { CompanionServer } = await import("../src/main/engine/companion.js");
  const crypto = await import("node:crypto");
  const https = await import("node:https");
  const f = fixture();
  const companion = new CompanionServer(f.home, { state: () => f.store.snapshot(), items: (id) => f.runner.items(id), status: (id) => f.runner.status(id), send: async () => ({ ok: true }), answer: () => {}, routineRuns: () => f.scheduler.list().runs }, () => ["127.0.0.1"], () => () => {});
  try {
    f.scheduler.start();
    const routine = f.scheduler.save(draft(f.project.id, { instructions: "SECRET_INSTRUCTIONS" }));
    await f.scheduler.runNow(routine.id);
    await until(() => f.ended.length === 1, "the run ends");
    const pairing = JSON.parse(Buffer.from(new URL((await companion.start()).pairingUri!).searchParams.get("data")!, "base64url").toString()) as { url: string; token: string; fingerprint: string };
    const body = await new Promise<string>((resolve, reject) => {
      https.get(new URL("/v1/snapshot", pairing.url), {
        headers: { authorization: `Bearer ${pairing.token}` }, ca: fs.readFileSync(path.join(f.home, "companion", "cert.pem")),
        checkServerIdentity: (_host, cert) => crypto.createHash("sha256").update(cert.raw).digest("hex") === pairing.fingerprint ? undefined : new Error("unpinned"),
      }, (res) => { let text = ""; res.on("data", (chunk) => { text += chunk; }); res.on("end", () => resolve(text)); }).on("error", reject);
    });
    const snapshot = JSON.parse(body) as { routineRuns: unknown[]; threads: { id: string; routine?: string }[] };
    const [run] = f.scheduler.list().runs;
    assert.deepEqual(snapshot.routineRuns, [{ id: run!.id, routine: "Nightly review", status: "completed", endedAt: run!.endedAt, threadId: run!.threadId }]);
    assert.equal(snapshot.threads.find((thread) => thread.id === run!.threadId)?.routine, "Nightly review");
    assert.ok(!body.includes("SECRET_INSTRUCTIONS") && !body.includes("Nothing changed overnight"), "no instructions or page content");
  } finally { await companion.dispose(); f.scheduler.dispose(); await f.runner.dispose(); }
});

test("resuming a paused routine starts from its next due time instead of running at once", async () => {
  let now = T0;
  const f = fixture({}, () => now);
  try {
    f.scheduler.start();
    const routine = f.scheduler.save(draft(f.project.id, { enabled: false }));
    now = Date.parse("2026-10-15T15:20:00.000Z");
    f.scheduler.tick();
    const resumed = f.scheduler.save({ ...draft(f.project.id), id: routine.id, enabled: true });
    assert.equal(resumed.nextRunAt, "2026-10-15T16:00:00.000Z");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(f.scheduler.list().runs.length, 0, "nothing ran while paused or on resume");
  } finally { f.scheduler.dispose(); await f.runner.dispose(); }
});


test("a turn stopped mid-run is an interrupted run: what it streamed is never saved as the page", async () => {
  const cli = new FakeCli("mock", { hold: true, partial: "Half a summ" });
  const f = fixture({ mock: cli });
  try {
    f.scheduler.start();
    const routine = f.scheduler.save(draft(f.project.id));
    await f.scheduler.runNow(routine.id);
    await until(() => cli.turns.length === 1 && Boolean(f.scheduler.list().runs[0]?.threadId), "the turn is streaming");
    f.runner.stop(f.scheduler.list().runs[0]!.threadId!);
    await until(() => f.ended.length === 1, "the run ends");
    assert.partialDeepStrictEqual(f.scheduler.list().runs[0], { status: "interrupted", error: "The turn was stopped before it finished." });
    assert.equal(f.store.space.list().length, 0, "no page from a partial reply");
  } finally { f.scheduler.dispose(); await f.runner.dispose(); }
});

test("a routine thread ignores Auto's default and runs the routine's own provider", async () => {
  const f = fixture({ claude: new FakeCli("claude") });
  try {
    f.store.updateSettings({ routing: { ...f.store.settings.routing, auto_by_default: true } });
    f.scheduler.start();
    const routine = f.scheduler.save(draft(f.project.id, { backend: "claude" }));
    await f.scheduler.runNow(routine.id);
    await until(() => f.ended.length === 1, "the run ends");
    const thread = f.store.thread(f.scheduler.list().runs[0]!.threadId!)!;
    assert.deepEqual([thread.auto, thread.backend, f.scheduler.list().runs[0]!.status], [false, "claude", "completed"]);
  } finally { f.scheduler.dispose(); await f.runner.dispose(); }
});

test("days follow the local calendar across a daylight-saving change", () => {
  const tz = process.env.TZ;
  process.env.TZ = "America/Chicago";
  try {
    // 09:00 CDT on 31 October; the clocks go back on 1 November.
    const daily = { kind: "interval", every: 1, unit: "days", from: "2026-10-31T14:00:00.000Z" } as const;
    assert.equal(new Date(nextDue(daily, Date.parse("2026-11-01T20:00:00Z"))!).toISOString(), "2026-11-02T15:00:00.000Z", "still 09:00, now CST");
    assert.equal(new Date(nextDue(daily, Date.parse("2026-10-31T14:00:00Z"))!).toISOString(), "2026-11-01T15:00:00.000Z");
  } finally {
    if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
  }
});

test("a run past its time limit ends failed at once, and its CLI is stopped twice", async () => {
  const cli = new FakeCli("mock", { hold: true, stubborn: true });
  const f = fixture({ mock: cli }, () => T0, undefined, { runTimeoutMs: 150, stopGraceMs: 100 });
  const stops: string[] = [];
  const stop = f.host.stop;
  f.host.stop = (id) => { stops.push(id); stop(id); };
  try {
    f.scheduler.start();
    const routine = f.scheduler.save(draft(f.project.id));
    await f.scheduler.runNow(routine.id);
    await until(() => f.ended.length === 1, "the time limit ends the run");
    assert.partialDeepStrictEqual(f.scheduler.list().runs[0], { status: "failed" });
    assert.match(f.scheduler.list().runs[0]!.error!, /took longer than/);
    await until(() => stops.length === 2, "a second stop follows");
    cli.release?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(f.store.space.list().length, 0);
    assert.equal(f.scheduler.list().runs[0]!.status, "failed", "a late reply changes nothing");
  } finally { f.scheduler.dispose(); cli.release?.(); await f.runner.dispose(); }
});

test("nothing runs before start, and start never cuts off a run of its own process", async () => {
  let now = T0;
  const f = fixture({}, () => now);
  try {
    const due = f.scheduler.save(draft(f.project.id, { trigger: { kind: "once", at: new Date(T0 - 60_000).toISOString() } }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(f.scheduler.list().runs.length, 0, "due, but not before start");
    const manual = f.scheduler.save(draft(f.project.id, { name: "Manual" }));
    await f.scheduler.runNow(manual.id);
    f.scheduler.start();
    await until(() => f.ended.length === 2, "both runs end");
    assert.deepEqual(f.scheduler.list().runs.map((run) => [run.routineName, run.status]).sort(), [["Manual", "completed"], ["Nightly review", "completed"]]);
    assert.equal(f.scheduler.list().routines.find((r) => r.id === due.id)!.nextRunAt, null);
  } finally { f.scheduler.dispose(); await f.runner.dispose(); }
});

test("a due time that waited on the previous run is scheduled, not missed", async () => {
  let now = Date.parse("2026-10-15T09:00:30.000Z");
  const cli = new FakeCli("mock", { hold: true });
  const f = fixture({ mock: cli }, () => now);
  try {
    f.scheduler.start();
    f.scheduler.save(draft(f.project.id, { trigger: { kind: "interval", every: 5, unit: "minutes", from: "2026-10-15T08:00:00.000Z" } }));
    now = Date.parse("2026-10-15T09:05:05.000Z");
    f.scheduler.tick();
    await until(() => cli.turns.length === 1, "the first run works");
    now = Date.parse("2026-10-15T09:13:00.000Z");
    f.scheduler.tick();
    cli.release?.();
    await until(() => f.ended.length === 1, "the first run ends");
    now = Date.parse("2026-10-15T09:13:30.000Z");
    f.scheduler.tick();
    await until(() => cli.turns.length === 2, "the next run starts");
    assert.equal(f.scheduler.list().runs[0]!.trigger, "schedule");
    cli.release?.();
    await until(() => f.ended.length === 2, "the second run ends");
  } finally { f.scheduler.dispose(); cli.release?.(); await f.runner.dispose(); }
});

test("notes that can't be read during recovery leave the run interrupted and routines still start", async () => {
  const f = fixture();
  const run: RoutineRun = { id: "66666666-7777-8888-9999-000000000001", routineId: "x", routineName: "Gone", projectId: f.project.id, trigger: "schedule", startedAt: new Date(T0).toISOString(), status: "running" };
  fs.mkdirSync(path.join(f.home, "app"), { recursive: true });
  fs.writeFileSync(path.join(f.home, "app", "routines.json"), JSON.stringify({ version: 1, routines: [], runs: [run] }));
  const host = { ...f.host, pages: { find: () => { throw new Error("invalid history"); }, write: f.host.pages.write.bind(f.host.pages) } };
  const scheduler = new RoutineScheduler(f.home, host, () => T0);
  try {
    scheduler.start();
    assert.equal(scheduler.list().runs[0]!.status, "interrupted");
    const routine = scheduler.save(draft(f.project.id));
    await scheduler.runNow(routine.id);
    await until(() => scheduler.list().runs[0]!.status !== "running", "a new run works");
  } finally { scheduler.dispose(); await f.runner.dispose(); }
});
