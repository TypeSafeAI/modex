# Chat Refresh Transcript (PR 3 of 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the transcript read as one quiet column: each turn is one element, its status is a small inline toggle, work is a list of 34 px rows, an answered approval is a receipt row, and reply actions stay out of the way until the turn is pointed at.

**Architecture:** `TurnContent` wraps what it renders today in one `.turn` element, so spacing, hover and focus can be scoped to a turn; the column rule that applied to the transcript's children moves to the wrapper's children at the same place in the stylesheet, so the cascade is unchanged. Thinking, tool, route and receipt rows share one row style (the one the route row already has). Wording and row kind are pure functions in `src/shared`, unit tested; the components only place them. Markup changes keep every existing `data-testid`, role and accessible name on the element that keeps the meaning.

**Tech Stack:** Existing TypeScript, React 19, Playwright; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-15-chat-prompts-refresh-design.md`, section "3. Transcript" and the receipt rows of "States the prototype did not show". Stacked on PR 2 (`chat-refresh-menus`).

## Scope calls (for Val to check)

1. **The reading column stays 938 px in this PR.** The design narrows it to 760 px for the transcript and the composer together; `layout.spec.ts` pins "column = composer box − 22 px". It moves with the composer in PR 5.
2. **An answered approval becomes a receipt row now; a waiting approval and the question card keep today's card.** The waiting card is replaced by the request panel in PR 4, and the answered question card (one answer per question, read by several specs) moves to a row there with the panel's question variant.
3. **Focus after an answer does not change here.** It still lands on the answer word, which is now in the receipt row. PR 4 moves it to the message box, as designed.
4. **A verb only for commands.** "Ran `$ git status`" / "Running …". Other tools' summaries come from the CLI's own title and already read as a phrase ("edit CONTRIBUTING.md"), so a verb in front would double it. Every row gets an icon for its kind.

## Global Constraints

- A work row is `34px` high with a `22px` icon tile (`--radius-xs`, `--tint-strong`), `10px` gap, text `--text-sm`; the target is `12.5px` `--font-mono`; meta is `--text-xs` in `--text-info` at the right.
- Row hover is `--tint`. Rows hang `6px` into the left margin so the tile, not the hover fill, sits on the column edge.
- The turn status line has no rule under it: `--text-sm`, weight `500`, `--text-3`, `26px` high. A live turn shows a `7px` dot: pulsing in `--text-1` while working, steady in `--warn` while waiting. Working text shimmers.
- Existing ids, roles and names stay: `turn-header` (`data-live`), `turn-label` (text exactly "Worked for 38s", "Working for 7s", "Waiting for approval · 7s", "Waiting for your answer · 7s"; a `button` with `aria-expanded` when the turn has work), `item`, `item-toggle`, `item-body`, `tool-title`, `tool-summary` (text unchanged), `tool-meta`, `thinking-label`, `approval-receipt`, `receipt-meta`, `approval-answer` (text unchanged, `tabindex="-1"`), `answer-note`, `approval-reason`, `message-actions`, `jump-latest` (accessible name "Jump to latest").
- The tool row's `aria-label` stays `"<status>: <summary>"`.
- Decision words are unchanged: "Approved", "Approved — always for this command", "Denied", "Sending decision…", "Delivery uncertain — not resent", and the three withdrawn sentences.
- Hidden reply actions use `opacity`, never `display` or `visibility`: they stay in the tab order and show on `:focus-within`. On a device without hover they always show.
- No animation under `prefers-reduced-motion`; under `forced-colors` the tile and the jump button get a system-colour border.
- Only dots are round (`50%`); the radius guard in `scripts/test/radius-scale.test.mjs` counts them per file and its count for `styles.css` changes with this PR.
- No behavior change: folding, focus hand-off to the turn toggle, scroll following and "Jump to latest" keep their logic.

## Review Focus

1. **A finished turn folds while focus is on the answer word of a receipt row.** Expected: focus moves to the turn's toggle, as today. Pinned by `keyboard-answers.spec.ts` (unchanged) and Task 2's markup keeping `approval-answer` focusable outside any button.
2. **An approval whose delivery is uncertain, loaded from disk.** Expected: a receipt row in the warn tone reading "Delivery uncertain — not resent", `data-answered="false"`, and the note under it. Pinned in Task 1 (unit) and Task 4 (spec).
3. **A stored thread with a tool the app has no kind for.** Expected: a row with the generic icon and today's summary, never an empty tile or a verb. Pinned in Task 1.
4. **Keyboard only, an older turn.** Expected: tabbing into the turn shows its reply actions; they are reachable without the pointer. Pinned in Task 4.
5. **A reader scrolled up in a long thread.** Expected: the jump button is a 32 px square that still reads "Jump to latest" to assistive tech and still returns focus to the message box. Pinned by the existing jump specs plus Task 4's size and name check.

---

### Task 1: Row kind, verb and answered-approval wording in `src/shared`

**Files:**
- Modify: `apps/desktop/src/shared/tool-summary.ts`
- Modify: `apps/desktop/src/shared/approval-receipt.ts`
- Test: `apps/desktop/test/tool-summary.test.ts`, `apps/desktop/test/approval-receipt.test.ts`

**Interfaces (produced):**

```ts
// tool-summary.ts
export type ToolKind = "command" | "edit" | "search" | "fetch" | "agent" | "file" | "other";
export function toolKind(item: Extract<ThreadItem, { kind: "tool" }>): ToolKind;
/** "Ran" or "Running" for a row whose summary is a command line ("$ …"); null for every other row. */
export function toolVerb(item: Extract<ThreadItem, { kind: "tool" }>): "Ran" | "Running" | null;

// approval-receipt.ts
export type AnsweredTone = "allowed" | "refused" | "warn" | "neutral";
export interface AnsweredApproval { text: string; tone: AnsweredTone; by: string | null }
/** The receipt row for an approval a person answered, or that closed unanswered. Null while it waits. */
export function answeredApproval(item: Extract<ThreadItem, { kind: "approval" }>): AnsweredApproval | null;
```

- [ ] **Step 1: failing tests**

```ts
test("a row's kind follows the tool, and only a command line gets a verb", () => {
  assert.deepEqual([
    toolKind(tool({ name: "shell", args: { command: "git status" } })), toolKind(tool({ name: "Bash", title: "Bash", args: { command: "npm test" } })),
    toolKind(tool({ name: "apply_patch" })), toolKind(tool({ name: "Write", args: { file_path: "a.ts" } })), toolKind(tool({ name: "write_file", args: { path: "a.ts" } })),
    toolKind(tool({ name: "WebSearch" })), toolKind(tool({ name: "webSearch" })), toolKind(tool({ name: "WebFetch" })),
    toolKind(tool({ name: "Agent", args: { description: "x" } })), toolKind(tool({ name: "read_file", args: { file_path: "a.ts" } })), toolKind(tool({ name: "mystery" })),
  ], ["command", "command", "edit", "edit", "edit", "search", "search", "fetch", "agent", "file", "other"]);
  assert.equal(toolVerb(tool({ name: "shell", args: { command: "git status" } })), "Running");
  assert.equal(toolVerb(tool({ name: "shell", status: "done", args: { command: "git status" } })), "Ran");
  assert.equal(toolVerb(tool({ title: "$ git status", status: "done" })), "Ran");
  assert.equal(toolVerb(tool({ name: "Bash", title: "Run the tests", status: "done", args: { command: "npm test" } })), null, "a CLI title is already a phrase");
  assert.equal(toolVerb(tool({ name: "read_file", status: "done", args: { file_path: "a.ts" } })), null);
});

test("an answered approval reads as one receipt line; a waiting one has none", () => {
  const approval = (over: object) => ({ id: "a", kind: "approval" as const, question: "Allow?", at: "", ...over });
  assert.equal(answeredApproval(approval({})), null);
  assert.deepEqual(answeredApproval(approval({ answer: "yes", answeredBy: "desktop" })), { text: "Approved", tone: "allowed", by: "by you" });
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
```

- [ ] **Step 2:** run them, expect "toolKind is not a function".
- [ ] **Step 3:** implement. Precedence in `answeredApproval` is today's: uncertain, then sending, then withdrawn, then the answer. `by` is "by you" only when `answeredBy === "desktop"`, the value main records for an answer given in this window; a phone or paired-desktop answer has its note instead, and an answer saved before the field existed claims nobody. `toolKind`: search and fetch by name (`WebSearch`, `webSearch`, `WebFetch`); agent by `Agent`/`Task`; edit by `PATCH_TOOLS` plus `write_file`; command when a `command` argument is a non-empty string or the name is `shell`/`Bash`; file when a path argument exists; else other. `toolVerb` is non-null only when `toolSummary(item)` starts with `"$ "`.
- [ ] **Step 4:** run them, expect pass. **Step 5:** commit.

### Task 2: Markup — turn wrapper, status line, rows, receipts, jump button

**Files:**
- Modify: `apps/desktop/src/renderer/components/transcript/TurnContent.tsx`, `ReasoningItem.tsx`
- Modify: `apps/desktop/src/renderer/components/ThreadView.tsx` (`ToolItem`, `ApprovalItem`, `ApprovalReceiptRow`, the jump button)
- Modify: `apps/desktop/src/renderer/components/ui/Icon.tsx` (`arrow-down`, `thought`)

**Consumes:** Task 1's `toolKind`, `toolVerb`, `answeredApproval`.

- [ ] `TurnContent` returns `<div className="turn" data-testid="turn" data-live="true|false">` around the user message, header, content and footer. Refs and effects are untouched.
- [ ] `TurnHeader`: class gains `waiting` while `status === "waiting"`; the label's text sits in `<span className="turn-text">`; a live label starts with `<span className="turn-dot" aria-hidden="true" />`.
- [ ] `ReasoningItem`: a `<span className="row-tile" aria-hidden="true">` with the `thought` icon before the label.
- [ ] `ToolItem`: the tile holds an icon by kind (`command` terminal, `edit` compose, `search` search, `fetch` globe, `agent` agents, `file` file, `other` shapes); `<span className="tool-verb">` before `tool-title` when `toolVerb` is non-null; the glyph characters go.
- [ ] `ApprovalReceiptRow` (rule or policy): `check` / `close` icons in the tile instead of "✓" / "✕".
- [ ] `ApprovalItem`, answered by a person or closed unanswered: the same root `div` (same ref, `data-testid="item"`, `data-item-kind`, `data-answered`, `data-delivery`, `data-decided-by`) with class `approval-receipt human <tone>`. Inside: a `div.receipt-head` holding the tile, `span.receipt-label` = `<span data-testid="approval-answer" data-withdrawn tabIndex={-1}>` + `<code>` with `item.title ?? item.question`, `span.receipt-meta` with `by`, and `<button className="receipt-toggle" data-testid="item-toggle" aria-expanded aria-label="Request details">`. The answer word is outside the button so it can take focus. The note, when `answerNote` returns one and the item is not withdrawn, is a `div.answer-note` (`data-testid="answer-note"`, `data-delivery`) under the head. Open: `div.receipt-body` (`item-body`) with the question, `approval-reason` when a rule asked, and the detail.
- [ ] Jump button: `arrow-down` icon and `<span className="sr-only">Jump to latest</span>`, `title="Jump to latest"`.

### Task 3: Styles

**Files:** Modify `apps/desktop/src/renderer/styles.css`; `scripts/test/radius-scale.test.mjs` (the `styles.css` circle count).

- [ ] Beside `.transcript > *`: `.transcript > .turn` resets the column, `.turn > *` takes it, `.turn > .turn-content` resets it; `.turn + .turn` gets `12px`.
- [ ] Turn header, rows, tiles, bodies, receipts and tones per Global Constraints; the route row joins the shared left margin.
- [ ] User bubble `max-width: 78%`, `padding: 9px 16px`. Reply actions fade per Global Constraints. A live reply's last block ends in a `7px` pulsing dot. The jump button is `32px` square.
- [ ] Reduced-motion and forced-colors rules.

### Task 4: Specs

**Files:**
- Modify: `apps/desktop/e2e/layout.spec.ts` ("Phase 6 · transcript": the column is measured on the first reply instead of the label; the label is `13px`, weight `500`, `rgb(170, 165, 184)`, with no bottom border)
- Create: `apps/desktop/e2e/transcript-rows.spec.ts`

- [ ] `transcript-rows.spec.ts`, on the mock backend's first turn ("Add a contributing guide"):
  1. A saved thread whose turn never answered (its work stays in view): the command row reads "Ran" before `$ npm test`, is 34 px high, and its tile is 22 px with the `terminal` icon; a tool the app has no kind for has the `shapes` icon and no verb; an approval that closed unanswered is a `neutral` row with its sentence; an approval saved at `delivery: "sending"` is, after the restart, a `warn` row reading "Delivery uncertain — not resent" with the note under it, and its toggle opens `item-body` with the question and detail.
  2. A saved thread with two finished turns: the older turn's `message-actions` has opacity 0, 1 while the turn is hovered and 1 when a control in it has focus; the newest turn's is 1.
  3. The same thread scrolled up: `jump-latest` is 32 × 32, has the accessible name "Jump to latest", and returns to the bottom.
  4. A live turn on the mock backend ("Add a contributing guide"): one `[data-testid="turn"]` holds the user message, header and approval; the waiting header has class `waiting` and a steady dot; after Approve the approval is an `allowed` receipt row reading "Approved … by you"; the finished header has no dot and is the toggle for the folded work.
- [ ] `keyboard-answers.spec.ts`: "Jump to latest from the keyboard" calls the file's own `ensureScrollable()` after its three turns, and that helper may add up to eight; a finished turn is shorter now, and the test's subject is the jump, not how many turns overflow a window.
- [ ] `docs/status.md`: PR 3 entry. Commit, push, draft PR on `chat-refresh-menus`.

## Verification available in this session

Installs are off, so `pnpm build`, the unit suite and the Electron specs first run in CI on the draft PR. Before pushing: Task 1's tests run through a type-stripped build; the renderer files are type-checked against stand-in declarations; `node --test scripts/test/*.test.mjs` runs; and the new markup is rendered with the real stylesheets in Chrome for a screenshot check.
