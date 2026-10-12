# Sticky Auto Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Auto from discarding a warm prompt cache: measure each turn's cache usage, then keep a thread's model while its cache is warm.

**Architecture:** Part 1 adds a `TurnUsage` report to both CLI backends, stores what the cache was built with on the thread (`Thread.lastTurn`), and adds cache figures to Auto's routing records, with no routing change. A manual probe then measures whether effort and fast-mode changes clear each CLI's cache. Part 2 adds a pure "hold" step to `decide()` that keeps the model, effort and fast mode while the cache is warm, with the exceptions the spec lists.

**Tech Stack:** TypeScript (Electron main process), `node:test` unit tests compiled by `tsc`, Playwright e2e, the `claude` and `codex` CLIs.

**Spec:** [`docs/specs/2026-10-12-sticky-auto-routing-spec.md`](../../specs/2026-10-12-sticky-auto-routing-spec.md)

---

## Conventions for every task

- Work in the session worktree, never the primary checkout. Part 1 uses `.worktrees/sticky-routing`
  (already created). Part 2 uses `.worktrees/sticky-hold`, created in Task 9.
- Paths below are relative to the worktree root unless a command `cd`s into `apps/desktop`.
- Unit tests live in `apps/desktop/test/*.test.ts` and run from compiled output:

  ```sh
  cd apps/desktop
  npm run build:main && node --test dist/test/<name>.test.js
  ```

  A missing module or type error fails `build:main` (tsc) before any test runs; that counts as the
  expected failure in a "verify it fails" step.
- Commits are signed and carry only the provenance trailer, never a co-author line:

  ```sh
  git commit -S -m "<subject>" -m "Coven-Harness: Claude Code / claude-opus-5-5"
  git log -1 --show-signature | grep -q 'Good "git" signature' || echo "UNSIGNED — stop"
  ```

- `scripts/worktree.sh new` can rewrite `package-lock.json`. Run `git status --short` before each
  commit and `git checkout -- package-lock.json` if it appears.
- Never place the cache probe's outputs in the tree except the trimmed fixtures named below.
  Probe scripts and raw captures stay in `apps/desktop/.probes/` (git-ignored).

## File map

| File | Part | Responsibility |
| --- | --- | --- |
| `apps/desktop/src/main/engine/backends/types.ts` | 1 | `TurnUsage`; `TurnResult.usage` |
| `apps/desktop/src/main/engine/backends/usage.ts` (new) | 1 | `UsageMeter`, `claudeCall`, `codexCall`, `withUsage` |
| `apps/desktop/src/main/engine/backends/claude.ts` | 1 | Feed assistant/result usage into a meter |
| `apps/desktop/src/main/engine/backends/codex.ts` | 1 | Feed `thread/tokenUsage/updated` into a meter |
| `apps/desktop/src/shared/types.ts` | 1, 2 | `LastTurn`, `Thread.lastTurn`; route item `held` |
| `apps/desktop/src/main/engine/runner.ts` | 1 | Write/clear `lastTurn`; pass usage to the router |
| `apps/desktop/src/main/engine/routing/fit.ts` | 1, 2 | `RouteRecord` cache fields; `warmth`, `held` |
| `apps/desktop/src/main/engine/routing/router.ts` | 1, 2 | Idle time and context into records; cache into `decide()` |
| `apps/desktop/src/main/engine/routing/policy.ts` | 2 | Constants, `warmth()`, hold step |
| `apps/desktop/src/renderer/components/ThreadView.tsx` | 2 | "Auto kept" for held routes |
| `apps/desktop/test/turn-usage.test.ts` (new) | 1 | Meter and mapping tests |
| `apps/desktop/test/runner-last-turn.test.ts` (new) | 1 | `lastTurn` lifecycle tests |
| `apps/desktop/test/routing-hold.test.ts` (new) | 2 | Warmth and hold policy tests |
| `apps/desktop/test/fixtures/usage/*` (new) | 1 | Trimmed real CLI captures |
| `docs/auto-routing.md`, `docs/status.md` | 1, 2 | User-facing documentation |

---

# Part 1 — measure (PR 1)

### Task 1: Align the spec with two implementation findings

Two spec details changed while planning. Codex output tokens come from the change in the
thread's running total, which is robust to repeated notifications. A replaced session handle no
longer clears `lastTurn`, because a resumed Claude session may report a new id while keeping the
same history (and the same cache).

**Files:**
- Modify: `docs/specs/2026-10-12-sticky-auto-routing-spec.md`

- [ ] **Step 1: Replace the Codex output sentence**

In the **Codex** paragraph, replace:

```
follows what it shows. `outputTokens` is the sum of `last.outputTokens` over the turn's
notifications if the captured payloads show one notification per response; otherwise Codex
leaves it unset.
```

with:

```
follows what it shows. `outputTokens` is the change in `tokenUsage.total.outputTokens` across the
turn: the last notification's total minus the total before the turn's first response (its total
less its `last.outputTokens`), which stays correct if a notification repeats.
```

- [ ] **Step 2: Drop the replaced-handle clearing rule**

Replace:

```
- It is cleared wherever `sessionHandle` is cleared (a backend change in `updateThread`), and
  when the session sink replaces an existing handle with a different one.
```

with:

```
- It is cleared wherever `sessionHandle` is cleared (a backend change in `updateThread`). A
  replaced handle does not clear it: a resumed Claude session can report a new id over the same
  history, and a genuinely fresh conversation reports a small context on its first turn.
```

- [ ] **Step 3: Commit**

```sh
git add docs/specs/2026-10-12-sticky-auto-routing-spec.md docs/superpowers/plans/2026-10-12-sticky-auto-routing.md
git commit -S -m "Plan sticky Auto routing" -m "Coven-Harness: Claude Code / claude-opus-5-5"
```

### Task 2: `TurnUsage` and the usage meter

**Files:**
- Modify: `apps/desktop/src/main/engine/backends/types.ts:101-108`
- Create: `apps/desktop/src/main/engine/backends/usage.ts`
- Test: `apps/desktop/test/turn-usage.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/test/turn-usage.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeCall, codexCall, UsageMeter, withUsage } from "../src/main/engine/backends/usage.js";

test("UsageMeter keeps the first call, sizes the context from the last, and counts each id once", () => {
  const meter = new UsageMeter();
  assert.equal(meter.usage(), undefined, "no call, no usage");
  meter.call({ cacheRead: 40_000, cacheWrite: 1_000, uncached: 5 }, "msg_1");
  meter.call({ cacheRead: 40_000, cacheWrite: 1_000, uncached: 5 }, "msg_1");
  meter.call({ cacheRead: 41_000, cacheWrite: 2_000, uncached: 3 }, "msg_2");
  meter.addOutput(700);
  meter.addOutput(300);
  assert.deepEqual(meter.usage(), { first: { cacheRead: 40_000, cacheWrite: 1_000, uncached: 5 }, contextTokens: 43_003, outputTokens: 1_000, calls: 2 });
});

test("calls without an id always count; unusable output values are ignored", () => {
  const meter = new UsageMeter();
  meter.call({ cacheRead: 0, cacheWrite: 0, uncached: 10 });
  meter.call({ cacheRead: 0, cacheWrite: 0, uncached: 10 });
  meter.addOutput(Number.NaN);
  meter.addOutput(-4);
  meter.addOutput("12");
  assert.deepEqual(meter.usage(), { first: { cacheRead: 0, cacheWrite: 0, uncached: 10 }, contextTokens: 10, calls: 2 });
});

test("Claude and Codex usage shapes map to the same split", () => {
  assert.deepEqual(claudeCall({ input_tokens: 2, cache_creation_input_tokens: 2293, cache_read_input_tokens: 371735 }), { cacheRead: 371735, cacheWrite: 2293, uncached: 2 });
  assert.deepEqual(claudeCall({}), { cacheRead: 0, cacheWrite: 0, uncached: 0 });
  assert.deepEqual(codexCall({ inputTokens: 50_000, cachedInputTokens: 45_000, cacheWriteInputTokens: 1_000 }), { cacheRead: 45_000, cacheWrite: 1_000, uncached: 4_000 });
  assert.deepEqual(codexCall({ inputTokens: 10, cachedInputTokens: 20 }), { cacheRead: 20, cacheWrite: 0, uncached: 0 }, "never negative");
});

test("withUsage attaches usage only when a call was seen", () => {
  const meter = new UsageMeter();
  assert.deepEqual(withUsage({ status: "completed" }, meter), { status: "completed" });
  meter.call({ cacheRead: 1, cacheWrite: 2, uncached: 3 });
  assert.deepEqual(withUsage({ status: "interrupted" }, meter), { status: "interrupted", usage: { first: { cacheRead: 1, cacheWrite: 2, uncached: 3 }, contextTokens: 6, calls: 1 } });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/desktop && npm run build:main && node --test dist/test/turn-usage.test.js`
Expected: `build:main` fails with `Cannot find module '../src/main/engine/backends/usage.js'`.

- [ ] **Step 3: Add the type**

In `apps/desktop/src/main/engine/backends/types.ts`, insert before `export interface TurnResult`:

```ts
/** Token usage a backend observed during one turn, for Auto routing and its records. */
export interface TurnUsage {
  /** The turn's first model call on the thread's own session: did it find the cache warm? */
  first: { cacheRead: number; cacheWrite: number; uncached: number };
  /** Total input of the turn's last model call (read + written + uncached): what the next turn re-reads. */
  contextTokens: number;
  /** Output tokens for the turn, reasoning included, as the CLI reports them. Informational only. */
  outputTokens?: number;
  /** Model calls counted. */
  calls: number;
}
```

and add a field at the end of `TurnResult`:

```ts
  /** Token usage the backend observed; absent when no model call was seen. */
  usage?: TurnUsage;
```

- [ ] **Step 4: Write the meter**

Create `apps/desktop/src/main/engine/backends/usage.ts`:

```ts
import type { TurnResult, TurnUsage } from "./types.js";

/** One model call's input, split the way both CLIs report it. */
export interface CallInput {
  cacheRead: number;
  cacheWrite: number;
  uncached: number;
}

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

/** A Claude API call's input from an `assistant` message's `message.usage`. */
export function claudeCall(u: { input_tokens?: unknown; cache_creation_input_tokens?: unknown; cache_read_input_tokens?: unknown }): CallInput {
  return { cacheRead: count(u.cache_read_input_tokens), cacheWrite: count(u.cache_creation_input_tokens), uncached: count(u.input_tokens) };
}

/** A Codex response's input from `tokenUsage.last`; `inputTokens` already includes cached and written tokens. */
export function codexCall(b: { inputTokens?: unknown; cachedInputTokens?: unknown; cacheWriteInputTokens?: unknown }): CallInput {
  const cacheRead = count(b.cachedInputTokens);
  const cacheWrite = count(b.cacheWriteInputTokens);
  return { cacheRead, cacheWrite, uncached: Math.max(0, count(b.inputTokens) - cacheRead - cacheWrite) };
}

/** Collects one turn's model calls into a `TurnUsage`. A call whose id was already counted is ignored. */
export class UsageMeter {
  private readonly seen = new Set<string>();
  private first?: CallInput;
  private last?: CallInput;
  private calls = 0;
  private output?: number;

  call(input: CallInput, id?: string): void {
    if (id !== undefined) {
      if (this.seen.has(id)) return;
      this.seen.add(id);
    }
    this.calls++;
    this.first ??= input;
    this.last = input;
  }

  /** Adds output tokens the CLI reported for part of the turn. */
  addOutput(tokens: unknown): void {
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) return;
    this.output = (this.output ?? 0) + Math.round(tokens);
  }

  usage(): TurnUsage | undefined {
    if (!this.first || !this.last) return undefined;
    const { cacheRead, cacheWrite, uncached } = this.last;
    return { first: { ...this.first }, contextTokens: cacheRead + cacheWrite + uncached, ...(this.output !== undefined ? { outputTokens: this.output } : {}), calls: this.calls };
  }
}

/** `result` with the turn's usage attached when the meter saw at least one model call. */
export function withUsage(result: TurnResult, meter: UsageMeter): TurnResult {
  const usage = meter.usage();
  return usage ? { ...result, usage } : result;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/desktop && npm run build:main && node --test dist/test/turn-usage.test.js`
Expected: 4 tests pass.

- [ ] **Step 6: Commit**

```sh
git add apps/desktop/src/main/engine/backends/types.ts apps/desktop/src/main/engine/backends/usage.ts apps/desktop/test/turn-usage.test.ts
git commit -S -m "Add a per-turn usage meter for CLI backends" -m "Coven-Harness: Claude Code / claude-opus-5-5"
```

### Task 3: Capture real CLI usage fixtures

This spends a few tokens on the signed-in Claude and Codex accounts (two tiny turns each).

**Files:**
- Create (ignored): `apps/desktop/.probes/codex-usage.mjs`
- Create: `apps/desktop/test/fixtures/usage/claude-turn.jsonl`
- Create: `apps/desktop/test/fixtures/usage/codex-token-usage.json`

- [ ] **Step 1: Capture one Claude turn and confirm resumed session ids**

```sh
cd apps/desktop && mkdir -p .probes
claude -p "Reply with the single word ok." --output-format stream-json --verbose --model haiku > .probes/claude-turn.jsonl
SID=$(node -e 'const l=require("fs").readFileSync(".probes/claude-turn.jsonl","utf8").trim().split("\n").map(JSON.parse);console.log(l.find(m=>m.type==="result").session_id)')
claude -p "Reply with the single word ok again." --output-format stream-json --verbose --model haiku --resume "$SID" > .probes/claude-resume.jsonl
node -e 'const l=require("fs").readFileSync(".probes/claude-resume.jsonl","utf8").trim().split("\n").map(JSON.parse);const r=l.find(m=>m.type==="result");console.log("resumed id same:", r.session_id===process.argv[1]);' "$SID"
```

Expected: the files contain `assistant` lines with `message.usage` and a `result` line. Record
whether the resumed id is the same; Task 1 already makes the design independent of the answer.

- [ ] **Step 2: Trim the Claude capture into a fixture**

```sh
cd apps/desktop && mkdir -p test/fixtures/usage
node -e '
const fs = require("fs");
const pick = (u) => u && { input_tokens: u.input_tokens, cache_creation_input_tokens: u.cache_creation_input_tokens, cache_read_input_tokens: u.cache_read_input_tokens, output_tokens: u.output_tokens };
const out = [];
for (const line of fs.readFileSync(".probes/claude-resume.jsonl", "utf8").split("\n")) {
  if (!line.trim()) continue;
  const m = JSON.parse(line);
  if (m.type === "assistant") out.push({ type: "assistant", parent_tool_use_id: m.parent_tool_use_id ?? null, session_id: "s", message: { id: m.message.id, content: [], usage: pick(m.message.usage) } });
  if (m.type === "result") out.push({ type: "result", subtype: m.subtype, is_error: m.is_error, result: "ok", session_id: "s", usage: pick(m.usage) });
}
fs.writeFileSync("test/fixtures/usage/claude-turn.jsonl", out.map((o) => JSON.stringify(o)).join("\n") + "\n");
console.log(out.length, "lines;", out.filter((o) => o.type === "assistant").length, "assistant");
'
```

Expected: at least one `assistant` line and exactly one `result` line. Open the file and confirm
it holds only ids and token counts (no prompt text, paths or account data).

- [ ] **Step 3: Write the Codex capture probe**

Create `apps/desktop/.probes/codex-usage.mjs`:

```js
// Prints every thread/tokenUsage/updated notification for two tiny turns on one Codex thread.
import { spawn } from "node:child_process";

const child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "inherit"] });
let next = 0;
const waiting = new Map();
let turnDone = null;
const send = (method, params) => new Promise((resolve, reject) => {
  const id = ++next;
  waiting.set(id, { resolve, reject });
  child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
});
let buf = "";
child.stdout.on("data", (d) => {
  buf += d;
  for (let n = buf.indexOf("\n"); n >= 0; n = buf.indexOf("\n")) {
    const line = buf.slice(0, n);
    buf = buf.slice(n + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && waiting.has(msg.id)) {
      const w = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) w.reject(new Error(JSON.stringify(msg.error)));
      else w.resolve(msg.result);
    } else if (msg.method === "thread/tokenUsage/updated") console.log(JSON.stringify(msg));
    else if (msg.method === "turn/completed") turnDone?.();
  }
});
const turn = async (threadId, text) => {
  const done = new Promise((r) => (turnDone = r));
  await send("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }] });
  await done;
};
await send("initialize", { clientInfo: { name: "modex-probe", title: "Modex probe", version: "0" }, capabilities: {} });
child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
const { thread } = await send("thread/start", { cwd: process.cwd(), approvalPolicy: "never", sandbox: "read-only", model: null });
await turn(thread.id, "Reply with the single word ok.");
await turn(thread.id, "Reply with the single word ok again.");
child.kill();
```

- [ ] **Step 4: Capture, check the convention, and trim**

```sh
cd apps/desktop
node .probes/codex-usage.mjs > .probes/codex-usage.jsonl
node -e '
const fs = require("fs");
const rows = fs.readFileSync(".probes/codex-usage.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l).params);
const turns = [...new Set(rows.map((p) => p.turnId))];
console.log("turns:", turns.length, "notifications per turn:", turns.map((t) => rows.filter((p) => p.turnId === t).length));
const second = rows.filter((p) => p.turnId === turns.at(-1)).map((p) => p.tokenUsage);
for (const u of second) {
  const l = u.last;
  console.log({ input: l.inputTokens, cached: l.cachedInputTokens, write: l.cacheWriteInputTokens, output: l.outputTokens, total: l.totalTokens, inclusive: l.totalTokens === l.inputTokens + l.outputTokens && l.inputTokens >= l.cachedInputTokens + (l.cacheWriteInputTokens ?? 0) });
}
fs.mkdirSync("test/fixtures/usage", { recursive: true });
fs.writeFileSync("test/fixtures/usage/codex-token-usage.json", JSON.stringify(second, null, 2) + "\n");
'
```

Expected: two turns; every printed row shows `inclusive: true`; the second turn's first row shows
`cached > 0`.

If any row shows `inclusive: false`, `inputTokens` excludes cached tokens. In that case change
`codexCall` in `usage.ts` to:

```ts
/** A Codex response's input from `tokenUsage.last`; `inputTokens` excludes cached and written tokens. */
export function codexCall(b: { inputTokens?: unknown; cachedInputTokens?: unknown; cacheWriteInputTokens?: unknown }): CallInput {
  return { cacheRead: count(b.cachedInputTokens), cacheWrite: count(b.cacheWriteInputTokens), uncached: count(b.inputTokens) };
}
```

and change the two `codexCall` expectations in `turn-usage.test.ts` to
`{ cacheRead: 45_000, cacheWrite: 1_000, uncached: 50_000 }` and
`{ cacheRead: 20, cacheWrite: 0, uncached: 10 }`, and update the spec's Codex sentence to say it
excludes them.

- [ ] **Step 5: Commit the fixtures**

```sh
git add apps/desktop/test/fixtures/usage
git commit -S -m "Add trimmed Claude and Codex usage captures as fixtures" -m "Coven-Harness: Claude Code / claude-opus-5-5"
```

### Task 4: Claude backend reports usage

**Files:**
- Modify: `apps/desktop/src/main/engine/backends/claude.ts`
- Test: `apps/desktop/test/claude-backend.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to the imports of `apps/desktop/test/claude-backend.test.ts`:

```ts
import { fileURLToPath } from "node:url";
import { claudeCall } from "../src/main/engine/backends/usage.js";
```

Append:

```ts
const tokens = (read: number, write: number, input: number, output = 1) => ({ input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: output });

test("ClaudeBackend reports usage: first call, last call's context, each id once, sub-agents excluded", async () => {
  const proc = new FakeProcess();
  const backend = new ClaudeBackend("claude", fakeSpawn(proc).spawn);
  const run = backend.runTurn("go", { cwd: "/repo", mode: "agent", plan: false, model: "opus" }, collectSink().sink, new AbortController().signal);
  await proc.waitFor((l) => l.includes('"type":"user"'));
  proc.emitLine({ type: "assistant", parent_tool_use_id: null, session_id: "s", message: { id: "m1", content: [], usage: tokens(40_000, 500, 3) } });
  proc.emitLine({ type: "assistant", parent_tool_use_id: null, session_id: "s", message: { id: "m1", content: [], usage: tokens(40_000, 500, 3) } });
  proc.emitLine({ type: "assistant", parent_tool_use_id: "toolu_agent", session_id: "s", message: { id: "sub1", content: [], usage: tokens(0, 9_000, 9) } });
  proc.emitLine({ type: "assistant", parent_tool_use_id: null, session_id: "s", message: { id: "m2", content: [], usage: tokens(40_500, 1_200, 2) } });
  proc.emitLine({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s", usage: { output_tokens: 850 } });
  const result = await run;
  assert.deepEqual(result.usage, { first: { cacheRead: 40_000, cacheWrite: 500, uncached: 3 }, contextTokens: 41_702, outputTokens: 850, calls: 2 });
});

test("ClaudeBackend usage spans the follow-up turn after background work", async () => {
  const proc = new FakeProcess();
  const backend = new ClaudeBackend("claude", fakeSpawn(proc).spawn);
  const run = backend.runTurn("run it in the background", { cwd: "/repo", mode: "agent", plan: false, model: "sonnet" }, collectSink(["yes"]).sink, new AbortController().signal);
  await proc.waitFor((l) => l.includes('"type":"user"'));
  proc.emitLine({ type: "system", subtype: "init", session_id: "s" });
  proc.emitLine({ type: "assistant", message: { id: "a1", usage: tokens(30_000, 100, 1, 5), content: [{ type: "tool_use", id: "tu-bg", name: "Bash", input: { command: "npm test", run_in_background: true } }] } });
  proc.emitLine({ type: "system", subtype: "task_started", task_id: "bash-1", tool_use_id: "tu-bg", task_type: "local_bash", is_backgrounded: true });
  proc.emitLine({ type: "result", subtype: "success", is_error: false, session_id: "s", result: "Started.", usage: { output_tokens: 40 } });
  proc.emitLine({ type: "system", subtype: "task_notification", task_id: "bash-1", tool_use_id: "tu-bg", status: "completed" });
  proc.emitLine({ type: "system", subtype: "init", session_id: "s" });
  proc.emitLine({ type: "assistant", message: { id: "a2", usage: tokens(30_100, 300, 1, 5), content: [{ type: "text", text: "Tests passed." }] } });
  proc.emitLine({ type: "result", subtype: "success", is_error: false, session_id: "s", result: "Done.", usage: { output_tokens: 60 } });
  const result = await run;
  assert.deepEqual(result.usage, { first: { cacheRead: 30_000, cacheWrite: 100, uncached: 1 }, contextTokens: 30_401, outputTokens: 100, calls: 2 });
  proc.close(0);
});

test("ClaudeBackend reads usage from a captured stream-json turn; a turn without usage reports none", async () => {
  const lines = fs.readFileSync(fileURLToPath(new URL("../../test/fixtures/usage/claude-turn.jsonl", import.meta.url)), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { type: string; message?: { id: string; usage: Record<string, number> }; usage?: { output_tokens: number } });
  const proc = new FakeProcess();
  const backend = new ClaudeBackend("claude", fakeSpawn(proc).spawn);
  const run = backend.runTurn("go", { cwd: "/repo", mode: "chat", plan: false, model: "haiku" }, collectSink().sink, new AbortController().signal);
  await proc.waitFor((l) => l.includes('"type":"user"'));
  for (const line of lines) proc.emitLine(line);
  const result = await run;
  const calls = [...new Map(lines.filter((l) => l.type === "assistant").map((l) => [l.message!.id, l.message!.usage])).values()];
  const last = claudeCall(calls.at(-1)!);
  assert.deepEqual(result.usage, {
    first: claudeCall(calls[0]!),
    contextTokens: last.cacheRead + last.cacheWrite + last.uncached,
    outputTokens: lines.find((l) => l.type === "result")!.usage!.output_tokens,
    calls: calls.length,
  });
  assert.ok(result.usage!.first.cacheRead > 0, "the captured resumed turn read the cache");

  const bare = new FakeProcess();
  const none = new ClaudeBackend("claude", fakeSpawn(bare).spawn).runTurn("go", { cwd: "/repo", mode: "chat", plan: false, model: "" }, collectSink().sink, new AbortController().signal);
  await bare.waitFor((l) => l.includes('"type":"user"'));
  bare.emitLine({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s" });
  assert.deepEqual(await none, { status: "completed" });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/desktop && npm run build:main && node --test dist/test/claude-backend.test.js`
Expected: the three new tests fail (`result.usage` is `undefined`); existing tests pass.

- [ ] **Step 3: Implement**

In `apps/desktop/src/main/engine/backends/claude.ts`:

Add an import after the `./types.js` imports:

```ts
import { claudeCall, UsageMeter, withUsage } from "./usage.js";
```

In `runTurn`, after `const init: Record<string, unknown> = {};` add:

```ts
      const meter = new UsageMeter();
```

In `onResult`, as its first statement add:

```ts
        meter.addOutput(msg.usage?.output_tokens);
```

In `finish`, replace the `resolve(...)` line with:

```ts
        resolve(withUsage(signal.aborted ? { status: "interrupted" } : r.status === "failed" ? { ...r, detail: { bin, argv, pid: child.pid, ...init, ...r.detail, stderr: stderrTail(stderr) || undefined } } : r, meter));
```

In the stdout line handler, directly before `if (msg.type === "result") return onResult(msg);` add:

```ts
          // The thread's own calls only: sub-agents run on their own context. One call can span several messages with one id.
          if (msg.type === "assistant" && !msg.parent_tool_use_id && msg.message?.usage) meter.call(claudeCall(msg.message.usage), msg.message.id);
```

In the `ClaudeMessage` interface, change the `message` field and add `usage`:

```ts
  message?: { id?: string; content?: ContentBlock[]; usage?: ClaudeUsage };
  /** `result`: the turn's token totals. */
  usage?: ClaudeUsage;
```

and add above `interface ClaudeMessage`:

```ts
interface ClaudeUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/desktop && npm run build:main && node --test dist/test/claude-backend.test.js dist/test/claude-background.test.js`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```sh
git add apps/desktop/src/main/engine/backends/claude.ts apps/desktop/test/claude-backend.test.ts
git commit -S -m "Report Claude turn usage from stream-json" -m "Coven-Harness: Claude Code / claude-opus-5-5"
```

### Task 5: Codex backend reports usage

**Files:**
- Modify: `apps/desktop/src/main/engine/backends/codex.ts`
- Test: `apps/desktop/test/codex-backend.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the imports of `apps/desktop/test/codex-backend.test.ts` (next to the other imports at
line 47 onward):

```ts
import { fileURLToPath } from "node:url";
import { codexCall } from "../src/main/engine/backends/usage.js";
```

Append:

```ts
test("CodexBackend reports the turn's usage from captured notifications and ignores other threads", async () => {
  const proc = new FakeProcess();
  const { threadId, turnId } = fakeServer(proc);
  const backend = new CodexBackend("codex", fakeSpawn(proc).spawn);
  const captured = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../test/fixtures/usage/codex-token-usage.json", import.meta.url)), "utf8")) as { last: Record<string, number>; total: Record<string, number> }[];
  try {
    const run = backend.runTurn("go", { cwd: "/w", mode: "agent", plan: false, model: "" }, collectSink().sink, new AbortController().signal);
    await proc.waitFor((l) => l.includes('"turn/start"'));
    proc.emitLine({ method: "thread/tokenUsage/updated", params: { threadId: "another-thread", turnId: "other", tokenUsage: captured[0] } });
    for (const tokenUsage of captured) proc.emitLine({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage } });
    proc.emitLine({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
    const result = await run;
    const first = captured[0]!;
    const final = captured.at(-1)!;
    const context = codexCall(final.last);
    assert.ok(first.last.cachedInputTokens! > 0, "the captured second turn read the cache");
    assert.deepEqual(result.usage, {
      first: codexCall(first.last),
      contextTokens: context.cacheRead + context.cacheWrite + context.uncached,
      outputTokens: final.total.outputTokens! - (first.total.outputTokens! - first.last.outputTokens!),
      calls: captured.length,
    });
  } finally { await backend.dispose(); }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/desktop && npm run build:main && node --test dist/test/codex-backend.test.js`
Expected: the new test fails (`result.usage` is `undefined`).

- [ ] **Step 3: Implement**

In `apps/desktop/src/main/engine/backends/codex.ts`, add after the `./types.js` imports:

```ts
import { codexCall, UsageMeter, withUsage } from "./usage.js";
```

In `attempt`, after `const retried: string[] = [];` add:

```ts
    const meter = new UsageMeter();
    // Output comes from the thread's running total: the total before this turn's first response, then the latest.
    let outputBase: number | undefined;
    let outputNow: number | undefined;
```

In `finish`, replace `resolve(r);` with:

```ts
        if (outputBase !== undefined && outputNow !== undefined) meter.addOutput(outputNow - outputBase);
        resolve(withUsage(r, meter));
```

In the `switch (msg.method)` block, add a case before `case "turn/started":`:

```ts
          case "thread/tokenUsage/updated": {
            const u = p.tokenUsage as { last?: Record<string, unknown>; total?: Record<string, unknown> } | undefined;
            if (!u?.last) break;
            meter.call(codexCall(u.last));
            const total = Number(u.total?.outputTokens);
            const last = Number(u.last.outputTokens);
            if (Number.isFinite(total)) {
              if (outputBase === undefined && Number.isFinite(last)) outputBase = total - last;
              outputNow = total;
            }
            break;
          }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/desktop && npm run build:main && node --test dist/test/codex-backend.test.js dist/test/account-codex.test.js`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```sh
git add apps/desktop/src/main/engine/backends/codex.ts apps/desktop/test/codex-backend.test.ts
git commit -S -m "Report Codex turn usage from token-usage notifications" -m "Coven-Harness: Claude Code / claude-opus-5-5"
```

### Task 6: The thread remembers what its cache was built with

**Files:**
- Modify: `apps/desktop/src/shared/types.ts` (`Thread`)
- Modify: `apps/desktop/src/main/engine/runner.ts`
- Test: `apps/desktop/test/runner-last-turn.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/test/runner-last-turn.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
import type { Backend, TurnResult } from "../src/main/engine/backends/types.js";
import { gitRepo, tmpdir } from "./helpers.js";

const backendReturning = (results: TurnResult[]): Backend => ({
  id: "codex",
  listModels: async () => [{ id: "gpt-6-luna", label: "Luna", efforts: ["low", "high"], isDefault: true }],
  dispose: async () => {},
  async runTurn(_text, _opts, sink) {
    sink.session("thr-1");
    return results.shift() ?? { status: "completed" };
  },
});

test("a turn that reached the model records what the cache was built with", async () => {
  const home = tmpdir("modex-last-turn-");
  const store = new Store(home);
  const project = store.addProject(gitRepo());
  const usage = { first: { cacheRead: 0, cacheWrite: 30_000, uncached: 5 }, contextTokens: 31_000, calls: 2 };
  const runner = new ThreadRunner({ home, store, emit: () => {}, backends: { codex: backendReturning([
    { status: "completed", usage },
    { status: "failed", error: "boom" },
    { status: "interrupted", usage: { ...usage, contextTokens: 32_000 } },
  ]) } });
  try {
    const thread = await runner.createThread(project.id, { backend: "codex", model: "gpt-6-luna" });
    runner.updateThread(thread.id, { effort: "high" });
    await runner.send(thread.id, "first");
    const first = store.thread(thread.id)!.lastTurn!;
    assert.deepEqual({ ...first, at: typeof first.at }, { at: "string", model: "gpt-6-luna", effort: "high", fast: false, contextTokens: 31_000 });
    await runner.send(thread.id, "second fails before any model call");
    assert.deepEqual(store.thread(thread.id)!.lastTurn, first, "no usage and not completed: the record stays");
    await runner.send(thread.id, "third is stopped after a call");
    assert.equal(store.thread(thread.id)!.lastTurn!.contextTokens, 32_000, "an interrupted turn that made calls still warmed the cache");
    runner.updateThread(thread.id, { backend: "claude" });
    assert.equal(store.thread(thread.id)!.lastTurn, undefined, "a backend switch starts a new conversation");
  } finally { await runner.dispose(); }
});

test("a completed turn from a CLI that reports no usage leaves a record without a size, and it persists", async () => {
  const home = tmpdir("modex-last-turn-");
  const store = new Store(home);
  const project = store.addProject(gitRepo());
  const runner = new ThreadRunner({ home, store, emit: () => {}, backends: { codex: backendReturning([{ status: "completed" }]) } });
  try {
    const thread = await runner.createThread(project.id, { backend: "codex", model: "gpt-6-luna" });
    await runner.send(thread.id, "hello");
    const last = store.thread(thread.id)!.lastTurn!;
    assert.deepEqual([last.model, last.fast, last.contextTokens], ["gpt-6-luna", false, undefined]);
    assert.equal(new Store(home).thread(thread.id)!.lastTurn!.model, "gpt-6-luna");
  } finally { await runner.dispose(); }
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/desktop && npm run build:main && node --test dist/test/runner-last-turn.test.js`
Expected: `build:main` fails: `Property 'lastTurn' does not exist on type 'Thread'`.

- [ ] **Step 3: Add the type**

In `apps/desktop/src/shared/types.ts`, insert before `export interface Thread`:

```ts
/** What a thread's last model-reaching turn ran with, and how much context the next turn re-reads. */
export interface LastTurn {
  /** When the turn ended. */
  at: string;
  model: string;
  effort?: string;
  fast: boolean;
  /** Input of the turn's last model call; absent when the CLI reported no usage. */
  contextTokens?: number;
}
```

and in `Thread`, after `sessionHandle?: string;`:

```ts
  /** The last turn that reached a model: what the backend's prompt cache was built with. Auto reads it. */
  lastTurn?: LastTurn;
```

- [ ] **Step 4: Write and clear it in the runner**

In `apps/desktop/src/main/engine/runner.ts`:

Add `LastTurn` to the type import on line 4 (`import type { ApprovalAnswer, …, ThreadStatus } from "../../shared/types.js";`)
and `TurnResult` to the type import on line 8 (`import type { ApprovalRequest, Backend, TurnSink } from "./backends/types.js";`).

Directly after the `const result = await backend.runTurn( … );` statement in `send`, add:

```ts
      this.noteLastTurn(threadId, thread, fast, result);
```

Add this method to the class, directly before `private sinkFor(`:

```ts
  /** Records what the backend's prompt cache was last built with, so Auto can avoid discarding it. */
  private noteLastTurn(threadId: string, ran: Thread, fast: boolean, result: TurnResult): void {
    if (!result.usage && result.status !== "completed") return;
    const now = this.o.store.thread(threadId);
    // A backend switch during the turn started another conversation; this record would describe the old one.
    if (!now || now.backend !== ran.backend) return;
    const lastTurn: LastTurn = {
      at: new Date().toISOString(), model: ran.model, fast,
      ...(ran.effort ? { effort: ran.effort } : {}),
      ...(result.usage ? { contextTokens: result.usage.contextTokens } : {}),
    };
    this.o.store.updateThread(threadId, { lastTurn });
  }
```

In `updateThread`, add `lastTurn: undefined` to the backend-switch `extra` object so it reads:

```ts
    const extra: Partial<Thread> = current && patch.backend && patch.backend !== current.backend ? { sessionHandle: undefined, codexAccount: undefined, lastTurn: undefined, model: this.o.store.settings.default_model[patch.backend] ?? "", effort: undefined } : {};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/desktop && npm run build:main && node --test dist/test/runner-last-turn.test.js dist/test/runner.test.js dist/test/store.test.js`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```sh
git add apps/desktop/src/shared/types.ts apps/desktop/src/main/engine/runner.ts apps/desktop/test/runner-last-turn.test.ts
git commit -S -m "Remember what each thread's prompt cache was built with" -m "Coven-Harness: Claude Code / claude-opus-5-5"
```

### Task 7: Routing records carry cache figures

**Files:**
- Modify: `apps/desktop/src/main/engine/routing/fit.ts`
- Modify: `apps/desktop/src/main/engine/routing/router.ts`
- Modify: `apps/desktop/src/main/engine/runner.ts`
- Test: `apps/desktop/test/routing.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/desktop/test/routing.test.ts`:

```ts
test("router: routing records carry the idle gap, the context the turn re-reads, and the turn's cache figures", async () => {
  const home = tmpdir("modex-home-");
  const router = new Router({ home, policy: () => DEFAULT_ROUTING, listModels, transport: async () => jevAnswers("small_edit", 0.6) });
  const at = new Date(Date.now() - 4 * 60_000).toISOString();
  await router.route({ thread: thread({ lastTurn: { at, model: "gpt-6-astra", effort: "high", fast: false, contextTokens: 150_000 } }), text: "rename a to b", items: [], project: { name: "demo" } });
  router.noteOutcome("th1", "completed", { first: { cacheRead: 149_000, cacheWrite: 900, uncached: 100 }, contextTokens: 152_000, outputTokens: 1_200, calls: 3 });
  const r = router.fit.latest("th1")!;
  assert.ok(r.idleMs! >= 4 * 60_000 && r.idleMs! < 5 * 60_000, `idle ${r.idleMs}`);
  assert.deepEqual([r.contextTokens, r.cacheRead, r.cacheWrite, r.uncached, r.turnContextTokens, r.outputTokens, r.outcome], [150_000, 149_000, 900, 100, 152_000, 1_200, "completed"]);
  await router.route({ thread: thread({ id: "th2" }), text: "rename a to b", items: [], project: { name: "demo" } });
  router.noteOutcome("th2", "failed");
  const bare = router.fit.latest("th2")!;
  assert.deepEqual([bare.idleMs, bare.contextTokens, bare.cacheRead, bare.outcome], [undefined, undefined, undefined, "failed"]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/desktop && npm run build:main && node --test dist/test/routing.test.js`
Expected: `build:main` fails: `Property 'idleMs' does not exist on type 'RouteRecord'`.

- [ ] **Step 3: Extend the record and the outcome**

In `apps/desktop/src/main/engine/routing/fit.ts`, add an import:

```ts
import type { TurnUsage } from "../backends/types.js";
```

Add to `RouteRecord`, after `overrideTier?: number;`:

```ts
  /** Time since the thread's last model-reaching turn, at decision time. */
  idleMs?: number;
  /** Context the previous turn left, which this turn re-reads, at decision time. */
  contextTokens?: number;
  /** This turn's first call: input read from the cache, written to it, and sent uncached. */
  cacheRead?: number;
  cacheWrite?: number;
  uncached?: number;
  /** Context this turn left for the next one. */
  turnContextTokens?: number;
  outputTokens?: number;
```

Replace `recordOutcome` with:

```ts
  recordOutcome(threadId: string, outcome: "completed" | "failed" | "interrupted", usage?: TurnUsage): void {
    const r = this.open(threadId);
    if (!r) return;
    r.outcome = outcome;
    if (usage) {
      Object.assign(r, { cacheRead: usage.first.cacheRead, cacheWrite: usage.first.cacheWrite, uncached: usage.first.uncached, turnContextTokens: usage.contextTokens });
      if (usage.outputTokens !== undefined) r.outputTokens = usage.outputTokens;
    }
    const t = (this.state.tasks[r.task] ??= empty());
    if (outcome === "failed") {
      t.failures += 1;
      t.offset = Math.min(MAX_OFFSET, t.offset + FAILURE_STEP);
    } else if (outcome === "completed") t.completions += 1;
    this.write();
  }
```

- [ ] **Step 4: Record idle time and context in the router**

In `apps/desktop/src/main/engine/routing/router.ts`:

Add an import:

```ts
import type { TurnUsage } from "../backends/types.js";
```

Directly before `const premiumExhausted = …` in `route`, add:

```ts
    const last = thread.lastTurn;
    const lastAt = last ? Date.parse(last.at) : Number.NaN;
    const idleMs = Number.isFinite(lastAt) ? Math.max(0, Date.now() - lastAt) : undefined;
```

In the `this.fit.recordRoute({ … })` call, append these properties after `premium`:

```ts
          ...(idleMs !== undefined ? { idleMs } : {}), ...(last?.contextTokens !== undefined ? { contextTokens: last.contextTokens } : {}),
```

Replace `noteOutcome` with:

```ts
  noteOutcome(threadId: string, outcome: "completed" | "failed" | "interrupted", usage?: TurnUsage): void {
    try { this.fit.recordOutcome(threadId, outcome, usage); } catch { /* Learning persistence cannot change a coding turn's outcome. */ }
  }
```

- [ ] **Step 5: Pass usage from the runner**

In `apps/desktop/src/main/engine/runner.ts`, change `if (auto) this.router.noteOutcome(threadId, result.status);` to:

```ts
      if (auto) this.router.noteOutcome(threadId, result.status, result.usage);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/desktop && npm run build:main && node --test dist/test/routing.test.js dist/test/routing-policy-hardening.test.js dist/test/runner-routing-ceiling.test.js dist/test/runner.test.js`
Expected: all tests pass, with the existing routing tests unchanged.

- [ ] **Step 7: Commit**

```sh
git add apps/desktop/src/main/engine/routing/fit.ts apps/desktop/src/main/engine/routing/router.ts apps/desktop/src/main/engine/runner.ts apps/desktop/test/routing.test.ts
git commit -S -m "Record idle time and cache figures in Auto routing records" -m "Coven-Harness: Claude Code / claude-opus-5-5"
```

### Task 8: Document, verify and land PR 1

**Files:**
- Modify: `docs/auto-routing.md`
- Modify: `docs/status.md`

- [ ] **Step 1: Document what is measured**

In `docs/auto-routing.md`, insert this section directly before `## Bounds you control`:

```markdown
## Cache usage

Both CLIs report token usage for every model call: Claude on each `assistant` message
(`cache_read_input_tokens`, `cache_creation_input_tokens`, `input_tokens`), Codex in
`thread/tokenUsage/updated`. Modex keeps two things from each turn: how the first call's input
split between cache reads, cache writes and uncached tokens, and the total input of the last
call, which is what the next turn re-reads. Sub-agent calls are not counted; they have their own
context.

The thread stores the latter as `lastTurn` in `state.json`, with the model, effort and fast mode
the turn ran on and when it ended. Auto's routing records in `routing-fit.json` add the idle time
and context size at decision time and the turn's cache figures afterwards, so the records show
what each switch actually cost.
```

- [ ] **Step 2: Record the change in status**

In `docs/status.md`, insert as the first bullet under `## On main, unreleased`:

```markdown
- **Cache usage per turn.** Claude and Codex turns report how much input the first model call
  read from the prompt cache, wrote to it or sent uncached, and how much context the next turn
  re-reads. Threads keep this as `lastTurn`; Auto's routing records add idle time and cache
  figures. Routing is unchanged; this is the measurement half of
  [sticky Auto routing](specs/2026-10-12-sticky-auto-routing-spec.md).
```

- [ ] **Step 3: Run what CI runs**

```sh
npm run build && npm test
npm run test:e2e -w @modex/desktop
```

Expected: build succeeds; all unit tests pass; all e2e tests pass. If terminal-cleanup tests fail
under heavy machine load, rerun that file alone before treating it as a failure.

- [ ] **Step 4: Commit the docs**

```sh
git add docs/auto-routing.md docs/status.md
git commit -S -m "Document per-turn cache usage" -m "Coven-Harness: Claude Code / claude-opus-5-5"
```

- [ ] **Step 5: Check signing and attribution, push, open the PR**

```sh
git fetch origin
git log origin/main..HEAD --pretty='%H %G?' | awk '$2 != "G" {print "UNSIGNED:", $0}'
git log origin/main..HEAD --format=%B | grep -iE '^(co-authored-by:|.*generated with)' | grep -iE 'claude|codex|copilot|gpt|gemini|anthropic|openai'
git push -u origin sticky-routing
gh pr create --title "Measure prompt-cache usage per turn" --body "<summary of Part 1, link to the spec and plan, test results>"
```

Expected: both checks print nothing. The PR body carries no tool attribution.

- [ ] **Step 6: Merge when green**

```sh
~/.claude/scripts/gh-merge-when-green.sh <pr-number> --squash
```

### Task 9: Probe whether effort and fast-mode changes clear each cache

Runs real turns on both CLIs (about five turns each on a ~40–50k-token context). Results set two
constants in Part 2 and go in PR 2's description.

**Files:**
- Create (ignored): `apps/desktop/.probes/cache-probe-claude.mjs`
- Create (ignored): `apps/desktop/.probes/cache-probe-codex.mjs`

- [ ] **Step 1: Create the Part 2 worktree from the merged main**

```sh
cd <repository root>
scripts/worktree.sh new sticky-hold
cd .worktrees/sticky-hold
git status --short   # revert package-lock.json if listed
```

- [ ] **Step 2: Write the Claude probe**

Create `apps/desktop/.probes/cache-probe-claude.mjs`:

```js
// Runs one Claude session with the flags Modex uses and prints each turn's first-call cache figures.
import { spawnSync } from "node:child_process";

const base = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "default"];
let session;
const turn = (label, prompt, flags) => {
  const args = [...base, ...flags, ...(session ? ["--resume", session] : []), prompt];
  const out = spawnSync("claude", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: process.argv[2] ?? process.cwd() });
  const lines = out.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const first = lines.find((m) => m.type === "assistant" && !m.parent_tool_use_id && m.message?.usage);
  const result = lines.find((m) => m.type === "result");
  session = result?.session_id ?? session;
  const u = first?.message?.usage ?? {};
  console.log(JSON.stringify({ label, read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens, uncached: u.input_tokens, error: result?.is_error ? result.result : undefined }));
};
turn("seed", "Read docs/status.md and docs/auto-routing.md in full, then reply with the single word ok.", ["--model", "opus", "--effort", "medium", "--allowedTools", "Read"]);
turn("same", "Reply with the single word ok.", ["--model", "opus", "--effort", "medium"]);
turn("effort", "Reply with the single word ok.", ["--model", "opus", "--effort", "high"]);
turn("fast", "Reply with the single word ok.", ["--model", "opus", "--effort", "high", "--settings", JSON.stringify({ fastMode: true })]);
turn("model", "Reply with the single word ok.", ["--model", "sonnet", "--effort", "high"]);
```

- [ ] **Step 3: Run it**

Run (from the worktree root so the doc paths resolve): `node apps/desktop/.probes/cache-probe-claude.mjs "$PWD" | tee apps/desktop/.probes/cache-probe-claude.out`

Expected: five JSON lines. `same.read` is close to `seed`'s total input. `model.read` is near 0.

Decide per row, comparing against `same.read`:
- `effort.read >= 0.8 × same.read` → Claude effort changes keep the cache: `EFFORT_CLEARS_CACHE.claude = false`. Otherwise `true`.
- `fast.read >= 0.8 × fast's previous turn read (effort.read)` → `FAST_CLEARS_CACHE.claude = false`. Otherwise `true`. If `fast` reports an error (fast mode unavailable on this account), keep `true` and note it.

- [ ] **Step 4: Write the Codex probe**

Create `apps/desktop/.probes/cache-probe-codex.mjs`:

```js
// Runs one Codex thread and prints each turn's first-call cache figures as effort, tier and model change.
import { spawn } from "node:child_process";

const child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "inherit"] });
let next = 0;
const waiting = new Map();
let onUsage = null;
let turnDone = null;
const send = (method, params) => new Promise((resolve, reject) => {
  const id = ++next;
  waiting.set(id, { resolve, reject });
  child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
});
let buf = "";
child.stdout.on("data", (d) => {
  buf += d;
  for (let n = buf.indexOf("\n"); n >= 0; n = buf.indexOf("\n")) {
    const line = buf.slice(0, n);
    buf = buf.slice(n + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && waiting.has(msg.id)) {
      const w = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) w.reject(new Error(JSON.stringify(msg.error)));
      else w.resolve(msg.result);
    } else if (msg.method === "thread/tokenUsage/updated") onUsage?.(msg.params.tokenUsage);
    else if (msg.method === "turn/completed") turnDone?.(msg.params.turn);
  }
});
const turn = async (label, threadId, text, extra = {}) => {
  const seen = [];
  onUsage = (u) => seen.push(u);
  const done = new Promise((r) => (turnDone = r));
  await send("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }], ...extra });
  const t = await done;
  const u = seen[0]?.last ?? {};
  console.log(JSON.stringify({ label, read: u.cachedInputTokens, write: u.cacheWriteInputTokens, input: u.inputTokens, status: t?.status, extra }));
};
await send("initialize", { clientInfo: { name: "modex-probe", title: "Modex probe", version: "0" }, capabilities: {} });
child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
const { data } = await send("model/list", {});
const visible = data.filter((m) => !m.hidden);
const main = visible.find((m) => m.isDefault) ?? visible[0];
const other = visible.find((m) => m.id !== main.id);
const efforts = (main.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort);
const [e1, e2] = [efforts.includes("medium") ? "medium" : efforts[0], efforts.includes("high") ? "high" : efforts.at(-1)];
const fast = (main.serviceTiers ?? []).some((t) => /fast/i.test(t.id));
const { thread } = await send("thread/start", { cwd: process.argv[2] ?? process.cwd(), approvalPolicy: "never", sandbox: "read-only", model: main.id });
await turn("seed", thread.id, "Read docs/status.md and docs/auto-routing.md in full, then reply with the single word ok.", { model: main.id, effort: e1 });
await turn("same", thread.id, "Reply with the single word ok.", { model: main.id, effort: e1 });
await turn("effort", thread.id, "Reply with the single word ok.", { model: main.id, effort: e2 });
if (fast) await turn("fast", thread.id, "Reply with the single word ok.", { model: main.id, effort: e2, serviceTierForTurn: "fast" });
else console.log(JSON.stringify({ label: "fast", skipped: `${main.id} offers no fast tier` }));
if (other) await turn("model", thread.id, "Reply with the single word ok.", { model: other.id, effort: null });
child.kill();
```

- [ ] **Step 5: Run it and decide**

Run: `node apps/desktop/.probes/cache-probe-codex.mjs "$PWD" | tee apps/desktop/.probes/cache-probe-codex.out`

Apply the same 0.8 rule to set `EFFORT_CLEARS_CACHE.codex` and `FAST_CLEARS_CACHE.codex` (a
skipped fast row keeps `true`). Keep both `.out` files; their numbers go in PR 2's description.

# Part 2 — hold the model (PR 2)

Work in `.worktrees/sticky-hold` from here on.

### Task 10: Constants and warmth

**Files:**
- Modify: `apps/desktop/src/main/engine/routing/policy.ts`
- Test: `apps/desktop/test/routing-hold.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/test/routing-hold.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { CACHE_LIFETIME_MS, decide, EFFORT_CLEARS_CACHE, FAST_CLEARS_CACHE, SMALL_CONTEXT_TOKENS, warmth, type DecisionInput } from "../src/main/engine/routing/policy.js";
import { ladder } from "../src/main/engine/routing/catalog.js";
import type { Judgments } from "../src/main/engine/routing/judge.js";
import { DEFAULT_ROUTING, type LastTurn, type ModelInfo, type RoutingPolicy } from "../src/shared/types.js";

const m = (id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({ id, label: id, efforts: ["low", "medium", "high", "xhigh", "max"], ...extra });
const claude = () => ladder("claude", ["haiku", "sonnet", "opus", "fable"].map((id) => m(id)));
const J = (over: Partial<Judgments> = {}): Judgments => ({ task: "small_edit", taskConfidence: 0.9, taskProbabilities: {}, complexity: 0.6, complexityConfidence: 0.8, blastRadius: 0.3, wantsSpeed: 0.1, needsDeepReasoning: 0.2, dependsOnPriorTurns: 0, ...over });
const last = (over: Partial<LastTurn> = {}): LastTurn => ({ at: "2026-10-12T00:00:00.000Z", model: "opus", effort: "high", fast: false, contextTokens: 150_000, ...over });
const D = (over: Partial<DecisionInput> = {}, policy: Partial<RoutingPolicy> = {}): DecisionInput => ({
  judgments: J(), source: "jev", policy: { ...DEFAULT_ROUTING, ...policy },
  current: { backend: "claude", model: "opus", effort: "high", hasSession: true },
  ladders: { claude: claude() }, fitOffset: 0, premiumExhausted: false,
  cache: { lastTurn: last(), idleMs: 4 * 60_000 }, ...over,
});
/** Runs `fn` with the cache-clearing constants for Claude set as given, then restores them. */
const withClears = (effort: boolean, fast: boolean, fn: () => void) => {
  const saved = [EFFORT_CLEARS_CACHE.claude, FAST_CLEARS_CACHE.claude];
  EFFORT_CLEARS_CACHE.claude = effort;
  FAST_CLEARS_CACHE.claude = fast;
  try { fn(); } finally { [EFFORT_CLEARS_CACHE.claude, FAST_CLEARS_CACHE.claude] = saved as [boolean, boolean]; }
};

test("warmth: none without cache info, a session, or on mock; unknown without a record; cold when idle or built for another model; small below the floor", () => {
  assert.equal(warmth(D({ cache: undefined })), "none");
  assert.equal(warmth(D({ current: { backend: "claude", model: "opus", effort: "high", hasSession: false } })), "none");
  assert.equal(warmth(D({ current: { backend: "mock", model: "opus", hasSession: true } })), "none");
  assert.equal(warmth(D({ cache: { idleMs: undefined } })), "unknown");
  assert.equal(warmth(D({ cache: { lastTurn: last({ model: "sonnet" }), idleMs: 0 } })), "cold");
  assert.equal(warmth(D({ cache: { lastTurn: last(), idleMs: CACHE_LIFETIME_MS.claude } })), "cold");
  assert.equal(warmth(D({ cache: { lastTurn: last({ contextTokens: SMALL_CONTEXT_TOKENS - 1 }), idleMs: 0 } })), "small");
  assert.equal(warmth(D({ cache: { lastTurn: last({ contextTokens: undefined }), idleMs: 0 } })), "warm");
  assert.equal(warmth(D()), "warm");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/desktop && npm run build:main && node --test dist/test/routing-hold.test.js`
Expected: `build:main` fails: `Module '"../src/main/engine/routing/policy.js"' has no exported member 'warmth'`.

- [ ] **Step 3: Implement constants, the input field and `warmth()`**

In `apps/desktop/src/main/engine/routing/policy.ts`:

Change the first import to:

```ts
import type { BackendId, EffortLevel, LastTurn, RoutingPolicy } from "../../../shared/types.js";
```

After the `EFFORTS` constant, add (set the two `*_CLEARS_CACHE` objects from Task 9's results):

```ts
/** How long a backend's prompt cache is assumed to survive an idle thread. Corrected from routing records. */
export const CACHE_LIFETIME_MS: Record<BackendId, number> = { claude: 60 * 60_000, codex: 60 * 60_000, mock: 0 };
/** Below this many context tokens a switch re-reads too little to matter. */
export const SMALL_CONTEXT_TOKENS = 20_000;
/** A warm thread moves up only to a model at least this many tiers higher... */
export const UPGRADE_TIERS = 2;
/** ...or when Jev is this confident the request needs deep reasoning... */
export const DEEP_REASONING_UPGRADE = 0.85;
/** ...and the request does not lean on earlier turns this strongly. */
export const PRIOR_TURNS_DEPENDENT = 0.7;
/** Whether changing effort or fast mode alone clears the backend's cached history. Set from the cache probe. */
export const EFFORT_CLEARS_CACHE: Record<BackendId, boolean> = { claude: true, codex: true, mock: false };
export const FAST_CLEARS_CACHE: Record<BackendId, boolean> = { claude: true, codex: true, mock: false };

/** How likely a switch is to discard a warm prompt cache on this thread. */
export type Warmth = "none" | "unknown" | "cold" | "small" | "warm";
```

Add to `DecisionInput`, after `premiumExhausted: boolean;`:

```ts
  /**
   * What the thread's prompt cache was built with, and how long ago. The router always passes it;
   * a caller that omits it gets a fresh choice every turn.
   */
  cache?: { lastTurn?: LastTurn; idleMs?: number };
```

Add after the `currentCandidate` function:

```ts
/** How likely a switch is to discard a warm prompt cache on this thread. */
export function warmth(input: DecisionInput): Warmth {
  const { current, cache } = input;
  if (!cache || !current.hasSession || current.backend === "mock") return "none";
  const last = cache.lastTurn;
  if (!last) return "unknown";
  if (last.model !== current.model) return "cold";
  if (cache.idleMs !== undefined && cache.idleMs >= CACHE_LIFETIME_MS[current.backend]) return "cold";
  if (last.contextTokens !== undefined && last.contextTokens < SMALL_CONTEXT_TOKENS) return "small";
  return "warm";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/desktop && npm run build:main && node --test dist/test/routing-hold.test.js`
Expected: 1 test passes.

- [ ] **Step 5: Commit**

```sh
git add apps/desktop/src/main/engine/routing/policy.ts apps/desktop/test/routing-hold.test.ts
git commit -S -m "Classify how warm a thread's prompt cache is" -m "Coven-Harness: Claude Code / claude-opus-5-5"
```

### Task 11: The hold step

**Files:**
- Modify: `apps/desktop/src/main/engine/routing/policy.ts`
- Test: `apps/desktop/test/routing-hold.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `apps/desktop/test/routing-hold.test.ts`:

```ts
test("a warm thread never moves down, and the receipt names the cache it keeps", () => {
  const d = decide(D());
  assert.deepEqual([d.model, d.effort, d.fast, d.held, d.pinned, d.warmth], ["opus", "high", false, true, false, "warm"]);
  assert.equal(d.reasons.at(-1), "Kept opus: ~150k tokens cached, last turn 4 min ago. Switching would re-read the history uncached.");
  const sizeless = decide(D({ cache: { lastTurn: last({ contextTokens: undefined }), idleMs: 4 * 60_000 } }));
  assert.equal(sizeless.reasons.at(-1), "Kept opus: cache still warm, last turn 4 min ago. Switching would re-read the history uncached.");
});

test("a warm thread keeps its model over another model of the same tier", () => {
  const rungs = ladder("claude", [m("haiku"), m("sonnet"), m("opus", { isDefault: true }), m("claude-opus-5"), m("fable")]);
  const d = decide(D({ judgments: J({ task: "feature", complexity: 2 }), current: { backend: "claude", model: "claude-opus-5", effort: "high", hasSession: true }, ladders: { claude: rungs }, cache: { lastTurn: last({ model: "claude-opus-5" }), idleMs: 60_000 } }));
  assert.deepEqual([d.model, d.held], ["claude-opus-5", true]);
});

test("a warm thread moves up only on a two-tier jump or a self-contained deep-reasoning request", () => {
  const sonnet = { current: { backend: "claude" as const, model: "sonnet", effort: "medium", hasSession: true }, cache: { lastTurn: last({ model: "sonnet", effort: "medium" }), idleMs: 60_000 } };
  const one = decide(D({ ...sonnet, judgments: J({ task: "feature", complexity: 2 }) }));
  assert.deepEqual([one.model, one.held], ["sonnet", true], "one tier up is held");
  const haiku = { current: { backend: "claude" as const, model: "haiku", effort: "low", hasSession: true }, cache: { lastTurn: last({ model: "haiku", effort: "low" }), idleMs: 60_000 } };
  const two = decide(D({ ...haiku, judgments: J({ task: "feature", complexity: 2 }) }));
  assert.deepEqual([two.model, two.held, two.warmth], ["opus", undefined, "warm"]);
  assert.equal(two.reasons.at(-1), "Moved up to opus despite the warm cache: 2 tiers above haiku.");
  const deep = decide(D({ ...sonnet, judgments: J({ task: "feature", complexity: 1.4, needsDeepReasoning: 0.9 }) }));
  assert.deepEqual([deep.model, deep.held], ["opus", undefined]);
  assert.equal(deep.reasons.at(-1), "Moved up to opus despite the warm cache: the request needs deep reasoning and stands on its own.");
  const leaning = decide(D({ ...sonnet, judgments: J({ task: "feature", complexity: 1.4, needsDeepReasoning: 0.9, dependsOnPriorTurns: 0.8 }) }));
  assert.deepEqual([leaning.model, leaning.held], ["sonnet", true], "a request that builds on earlier turns needs the full jump");
});

test("on the same model, effort and fast mode are held only where changing them clears the cache", () => {
  const input = D({ judgments: J({ task: "feature", complexity: 2 }), current: { backend: "claude", model: "opus", effort: "medium", hasSession: true }, cache: { lastTurn: last({ effort: "medium", fast: true }), idleMs: 4 * 60_000 } });
  withClears(true, true, () => {
    const d = decide(input);
    assert.deepEqual([d.model, d.effort, d.fast, d.held], ["opus", "medium", true, true]);
    assert.equal(d.reasons.at(-1), "Kept opus at medium effort in fast mode: ~150k tokens cached, last turn 4 min ago. Changing effort would re-read the history uncached.");
  });
  withClears(false, false, () => {
    const d = decide(input);
    assert.deepEqual([d.model, d.effort, d.fast, d.held], ["opus", "high", false, undefined]);
  });
});

test("a held route keeps the last turn's fast mode only while fast mode is allowed", () => {
  assert.equal(decide(D({ cache: { lastTurn: last({ fast: true }), idleMs: 0 } })).fast, true);
  assert.equal(decide(D({ cache: { lastTurn: last({ fast: true }), idleMs: 0 } }, { allow_fast: false })).fast, false);
});

test("limits win over the cache: a top-tier model over the premium budget is not held", () => {
  const d = decide(D({ current: { backend: "claude", model: "fable", effort: "high", hasSession: true }, cache: { lastTurn: last({ model: "fable" }), idleMs: 0 }, premiumExhausted: true }));
  assert.deepEqual([d.model, d.held, d.warmth], ["sonnet", undefined, "warm"]);
});

test("cold, small and unknown threads say why; without cache info the choice is today's", () => {
  const idle = decide(D({ cache: { lastTurn: last(), idleMs: CACHE_LIFETIME_MS.claude + 12 * 60_000 } }));
  assert.deepEqual([idle.model, idle.held, idle.warmth], ["sonnet", undefined, "cold"]);
  assert.equal(idle.reasons.at(-1), "Idle 72 min, cache likely expired, so free choice.");
  const other = decide(D({ cache: { lastTurn: last({ model: "sonnet" }), idleMs: 0 } }));
  assert.equal(other.reasons.at(-1), "The cache was built for another model, so free choice.");
  const small = decide(D({ cache: { lastTurn: last({ contextTokens: 12_000 }), idleMs: 0 } }));
  assert.deepEqual([small.model, small.warmth], ["sonnet", "small"]);
  assert.equal(small.reasons.at(-1), "Only ~12k tokens of context, so switching is cheap.");
  const unknown = decide(D({ cache: { idleMs: undefined } }));
  assert.deepEqual([unknown.model, unknown.held, unknown.warmth], ["opus", true, "unknown"]);
  assert.equal(unknown.reasons.at(-1), "Kept opus: no cache record for this thread yet.");
  const today = decide(D({ cache: undefined }));
  assert.deepEqual([today.model, today.held, today.warmth], ["sonnet", undefined, undefined]);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/desktop && npm run build:main && node --test dist/test/routing-hold.test.js`
Expected: `build:main` fails: `Property 'held' does not exist on type 'Decision'`.

- [ ] **Step 3: Implement**

In `apps/desktop/src/main/engine/routing/policy.ts`:

Add to `Decision`, after `blocked?: true;`:

```ts
  /** True when a warm prompt cache kept the thread's model, effort or fast mode. */
  held?: true;
  /** The cache warmth the hold step saw; absent when no cache information was passed. */
  warmth?: Warmth;
```

Add these helpers directly before `export function decide`:

```ts
const kTokens = (n: number): string => `~${Math.max(1, Math.round(n / 1000))}k`;
const minutes = (ms: number | undefined): string => `${Math.max(0, Math.round((ms ?? 0) / 60_000))} min`;

function heldFast(input: DecisionInput, current: Candidate): boolean {
  return Boolean(input.cache?.lastTurn?.fast) && input.policy.allow_fast && Boolean(current.fastTier || current.backend === "claude");
}

/** keepCurrent's route marked as held, or undefined when a limit stops the current route. */
function heldRoute(input: DecisionInput, current: Candidate, reasons: string[]): Decision | undefined {
  const notes: string[] = [];
  const kept = keepCurrent(input, current, notes);
  if (kept.blocked) return undefined;
  reasons.push(...notes);
  return { ...kept, reasons, fast: heldFast(input, current), pinned: false, held: true };
}

/**
 * Keeps a warm thread on the model its prompt cache was built with. A switch re-reads the whole
 * history uncached and drops the previous model's thinking, so a warm thread moves only up, and
 * only on a big jump. Limits still win: a model that is gone or over budget is not held.
 */
function hold(input: DecisionInput, free: Decision, current: Candidate | undefined, reasons: string[]): Decision {
  const w = warmth(input);
  if (w === "none") return free;
  const last = input.cache?.lastTurn;
  if (w === "cold") {
    reasons.push(last && last.model !== input.current.model ? "The cache was built for another model, so free choice." : `Idle ${minutes(input.cache?.idleMs)}, cache likely expired, so free choice.`);
    return { ...free, warmth: w };
  }
  if (w === "small") {
    reasons.push(`Only ${kTokens(last!.contextTokens!)} tokens of context, so switching is cheap.`);
    return { ...free, warmth: w };
  }
  if (!current || (input.premiumExhausted && current.tier === 3)) return { ...free, warmth: w };
  const state = w === "unknown" ? "no cache record for this thread yet" : `${last!.contextTokens !== undefined ? `${kTokens(last!.contextTokens)} tokens cached` : "cache still warm"}, last turn ${minutes(input.cache?.idleMs)} ago`;
  const tail = (change: string) => (w === "unknown" ? "" : ` ${change} would re-read the history uncached.`);
  if (free.model === current.model) {
    const effort = EFFORT_CLEARS_CACHE[current.backend] ? heldRoute(input, current, [])?.effort ?? free.effort : free.effort;
    const fast = FAST_CLEARS_CACHE[current.backend] ? heldFast(input, current) : free.fast;
    if (effort === free.effort && fast === free.fast) return { ...free, warmth: w };
    reasons.push(`Kept ${current.label} at ${effort ?? "its default"} effort${fast ? " in fast mode" : ""}: ${state}.${tail(effort !== free.effort ? "Changing effort" : "Changing fast mode")}`);
    return { ...free, effort, fast, held: true, warmth: w };
  }
  if (free.tier > current.tier) {
    const to = (input.ladders[free.backend] ?? []).find((c) => c.model === free.model)?.label ?? free.model;
    const j = input.judgments;
    if (free.tier - current.tier >= UPGRADE_TIERS) {
      reasons.push(`Moved up to ${to} despite the warm cache: ${free.tier - current.tier} tiers above ${current.label}.`);
      return { ...free, warmth: w };
    }
    if (j.needsDeepReasoning >= DEEP_REASONING_UPGRADE && j.dependsOnPriorTurns < PRIOR_TURNS_DEPENDENT) {
      reasons.push(`Moved up to ${to} despite the warm cache: the request needs deep reasoning and stands on its own.`);
      return { ...free, warmth: w };
    }
  }
  const kept = heldRoute(input, current, reasons);
  if (!kept) return { ...free, warmth: w };
  reasons.push(`Kept ${current.label}: ${state}.${tail("Switching")}`);
  return { ...kept, warmth: w };
}
```

At the end of `decide`, replace:

```ts
  return { backend, model: candidate.model, effort, fast, tier: candidate.tier, pinned: false, reasons };
```

with:

```ts
  // 7. Hold: a warm prompt cache keeps the thread where it is unless the jump is worth a rebuild.
  return hold(input, { backend, model: candidate.model, effort, fast, tier: candidate.tier, pinned: false, reasons }, candidateNow, reasons);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/desktop && npm run build:main && node --test dist/test/routing-hold.test.js dist/test/routing.test.js dist/test/routing-policy-hardening.test.js`
Expected: all tests pass. Existing tests pass unchanged because they pass no `cache`.

- [ ] **Step 5: Commit**

```sh
git add apps/desktop/src/main/engine/routing/policy.ts apps/desktop/test/routing-hold.test.ts
git commit -S -m "Hold a warm thread's model, effort and fast mode in Auto" -m "Coven-Harness: Claude Code / claude-opus-5-5"
```

### Task 12: The router passes the cache, and receipts and records show holds

**Files:**
- Modify: `apps/desktop/src/shared/types.ts` (route `ThreadItem`)
- Modify: `apps/desktop/src/main/engine/routing/fit.ts` (`RouteRecord`)
- Modify: `apps/desktop/src/main/engine/routing/router.ts`
- Modify: `apps/desktop/src/renderer/components/ThreadView.tsx`
- Test: `apps/desktop/test/routing.test.ts`, `apps/desktop/e2e/review.spec.ts`

- [ ] **Step 1: Write the failing tests**

Append to `apps/desktop/test/routing.test.ts`:

```ts
test("router: a warm thread keeps its model, and the receipt and record say so", async () => {
  const home = tmpdir("modex-home-");
  const router = new Router({ home, policy: () => DEFAULT_ROUTING, listModels, transport: async () => jevAnswers("small_edit", 0.6) });
  const lastTurn = { at: new Date(Date.now() - 4 * 60_000).toISOString(), model: "gpt-6-astra", effort: "high", fast: false, contextTokens: 150_000 };
  const r = await router.route({ thread: thread({ sessionHandle: "thr-9", lastTurn }), text: "rename a to b", items: [], project: { name: "demo" } });
  assert.deepEqual([r.item.model, r.item.effort, r.item.held, r.item.pinned], ["gpt-6-astra", "high", true, false]);
  assert.match(r.item.reasons.at(-1)!, /^Kept gpt-6-astra: ~150k tokens cached, last turn 4 min ago\./);
  const record = router.fit.latest("th1")!;
  assert.deepEqual([record.warmth, record.held], ["warm", true]);
  const fresh = await router.route({ thread: thread({ id: "th2" }), text: "rename a to b", items: [], project: { name: "demo" } });
  assert.deepEqual([fresh.item.model, fresh.item.held], ["gpt-5.6-x", undefined], "no session: a free choice, as before");
});
```

In `apps/desktop/e2e/review.spec.ts`, replace the test
`"blocked Auto receipts identify the stop while older pinned receipts still show Auto kept"` with:

```ts
test("blocked Auto receipts identify the stop while pinned and held receipts show Auto kept", async () => {
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    const receipt = { kind: "route", backend: "codex", model: "", effort: undefined, fast: false, source: "heuristic", task: "review", confidence: 0.9, complexity: 2, pinned: true, reasons: ["Cannot honor the effort ceiling; the route was stopped."], durationMs: 1, at: new Date().toISOString() };
    win.webContents.send("thread:event", { type: "item", threadId: "one", item: { ...receipt, id: "blocked", blocked: true } });
    win.webContents.send("thread:event", { type: "item", threadId: "one", item: { ...receipt, id: "held", pinned: false, held: true, model: "gpt-6-astra", reasons: ["Kept gpt-6-astra: ~150k tokens cached, last turn 4 min ago. Switching would re-read the history uncached."] } });
    win.webContents.send("thread:event", { type: "item", threadId: "one", item: { ...receipt, id: "legacy-pinned" } });
  });
  const receipts = items(page, "route");
  await expect(tid(receipts.first(), "route-label")).toHaveText("Auto blocked Codex · CLI default");
  await expect(tid(receipts.nth(1), "route-label")).toContainText("Auto kept");
  await expect(tid(receipts.last(), "route-label")).toContainText("Auto kept");
  await tid(receipts.first(), "item-toggle").click();
  await expect(tid(receipts.first(), "item-body")).toContainText("Cannot honor the effort ceiling");
  await tid(receipts.nth(1), "item-toggle").click();
  await expect(tid(receipts.nth(1), "item-body")).toContainText("~150k tokens cached");
});
```

- [ ] **Step 2: Run the unit test to verify it fails**

Run: `cd apps/desktop && npm run build:main && node --test dist/test/routing.test.js`
Expected: `build:main` fails: `Property 'held' does not exist` on the route item type.

- [ ] **Step 3: Extend the item and record types**

In `apps/desktop/src/shared/types.ts`, in the `kind: "route"` member of `ThreadItem`, add
`held?: true;` after `blocked?: true;`.

In `apps/desktop/src/main/engine/routing/fit.ts`, add an import and two fields to `RouteRecord`
(after `outputTokens?: number;`):

```ts
import type { Warmth } from "./policy.js";
```

```ts
  /** How warm the thread's prompt cache was when Auto decided. */
  warmth?: Warmth;
  /** True when the warm cache kept the thread's model, effort or fast mode. */
  held?: boolean;
```

- [ ] **Step 4: Pass the cache and record the hold in the router**

In `apps/desktop/src/main/engine/routing/router.ts`, in the `decide({ … })` call, add after
`fitOffset: this.fit.offsetFor(judgments.task),`:

```ts
      cache: { lastTurn: last, idleMs },
```

In the `this.fit.recordRoute({ … })` call, append after the `contextTokens` spread added in
Task 7:

```ts
          ...(decision.warmth ? { warmth: decision.warmth } : {}), ...(decision.held ? { held: true } : {}),
```

In the `item` literal, add after `blocked: decision.blocked,`:

```ts
      ...(decision.held ? { held: true as const } : {}),
```

- [ ] **Step 5: Label held receipts**

In `apps/desktop/src/renderer/components/ThreadView.tsx`, in `RouteItem`, change
`{item.blocked ? "Auto blocked" : item.pinned ? "Auto kept" : "Auto picked"}` to:

```tsx
          {item.blocked ? "Auto blocked" : item.pinned || item.held ? "Auto kept" : "Auto picked"}
```

- [ ] **Step 6: Run the tests to verify they pass**

```sh
cd apps/desktop
npm run build:main && node --test dist/test/routing.test.js dist/test/runner.test.js dist/test/runner-routing-ceiling.test.js
npm run build && npx playwright test e2e/review.spec.ts -g "Auto receipts"
```

Expected: unit tests pass; the e2e test passes.

- [ ] **Step 7: Commit**

```sh
git add apps/desktop/src/shared/types.ts apps/desktop/src/main/engine/routing/fit.ts apps/desktop/src/main/engine/routing/router.ts apps/desktop/src/renderer/components/ThreadView.tsx apps/desktop/test/routing.test.ts apps/desktop/e2e/review.spec.ts
git commit -S -m "Show and record when a warm cache keeps the model" -m "Coven-Harness: Claude Code / claude-opus-5-5"
```

### Task 13: Document, verify and land PR 2

**Files:**
- Modify: `docs/auto-routing.md`
- Modify: `docs/status.md`

- [ ] **Step 1: Document the hold**

In `docs/auto-routing.md`:

Change the last sentence of step 3 from
`Mid-thread switches lose the CLI's context, so this is off by default.` to
`Mid-thread switches lose the CLI's context, so this is off by default; model switches have their own guard in step 7.`

Insert after step 6 (`6. **Fast mode.** …`), before `Changing the policy never requires re-asking Jev`:

```markdown
7. **Holding the model.** On a thread with a CLI session, a switch re-reads the whole history
   without the prompt cache and drops the previous model's thinking. So Auto keeps the model
   while the cache is likely warm. It still chooses freely on the first turn, after the thread
   has been idle 60 minutes or more, when the last turn left under 20k tokens of context, and
   when you have picked a different model since the last turn. While the cache is warm it never
   moves down, and it moves up only to a model two or more tiers higher, or when Jev is at least
   0.85 sure the request needs deep reasoning and the request does not lean on earlier turns.
   A kept model keeps its effort and fast mode too. On the same model, effort and fast mode are
   held only where changing them clears the cache: <probe results from Task 9, one line per
   CLI, e.g. "Claude: effort keeps the cache, fast mode clears it; Codex: both keep it">.
   Limits still win: a model over the premium budget or no longer listed is not held. A held
   route reads "Auto kept", with the cache size and idle time in its reasons.
```

- [ ] **Step 2: Update status**

In `docs/status.md`, replace the **Cache usage per turn** bullet under `## On main, unreleased`
with:

```markdown
- **Sticky Auto routing.** Auto keeps a thread's model while its prompt cache is warm, because
  a switch re-reads the whole history uncached. It still chooses freely on a thread's first turn,
  after an hour idle, on small threads, and after you pick a model; while warm it moves up only on
  a two-tier jump or a self-contained deep-reasoning request. Held routes read "Auto kept" with
  the cache size and idle time. Claude and Codex turns now report cache usage, kept on the thread
  and in Auto's routing records. [Spec](specs/2026-10-12-sticky-auto-routing-spec.md).
```

- [ ] **Step 3: Run what CI runs**

```sh
npm run build && npm test
npm run test:e2e -w @modex/desktop
```

Expected: everything passes.

- [ ] **Step 4: Commit, check, push, open the PR**

```sh
git add docs/auto-routing.md docs/status.md
git commit -S -m "Document holding the model on warm threads" -m "Coven-Harness: Claude Code / claude-opus-5-5"
git fetch origin
git log origin/main..HEAD --pretty='%H %G?' | awk '$2 != "G" {print "UNSIGNED:", $0}'
git log origin/main..HEAD --format=%B | grep -iE '^(co-authored-by:|.*generated with)' | grep -iE 'claude|codex|copilot|gpt|gemini|anthropic|openai'
git push -u origin sticky-hold
gh pr create --title "Keep Auto's model while the prompt cache is warm" --body "<summary, probe tables from Task 9, test results>"
```

Expected: both checks print nothing.

- [ ] **Step 5: Merge when green**

```sh
~/.claude/scripts/gh-merge-when-green.sh <pr-number> --squash
```
