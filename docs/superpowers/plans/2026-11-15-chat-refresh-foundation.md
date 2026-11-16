# Chat Refresh Foundation (PR 1 of 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the renderer one radius scale, three tint tokens and one in-app confirm dialog that replaces every `window.confirm`, so the later chat-refresh PRs build on them.

**Architecture:** Tokens change in `tokens.css` and every renderer stylesheet moves its hard-coded radii onto them, guarded by a file-scanning test. Confirmations go through a small module-level store (`confirmDialog(options): Promise<boolean>`) rendered by one `ConfirmHost` mounted in `App`, so the desktop app, the Store edition and the web demo get it without each call site owning dialog state.

**Tech Stack:** Existing TypeScript, React 19, Electron, Playwright, `node:test`; pinned pnpm. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-15-chat-prompts-refresh-design.md`, sections "Shared: tokens and buttons" and "1. Confirm dialog". PRs 2 to 5 (menus, transcript, request panel, composer) each get their own plan from the same spec.

## Global Constraints

- Radius scale, exact values: surface `8px` (`--radius-md`, `--radius-composer`, `--radius-sheet`), control `6px` (`--radius-sm`, `--radius-row`, `--radius-pill`), part `4px` (`--radius-xs`, new).
- New tokens live in the base `:root` block of `tokens.css` only. No theme block gains or changes a token (the brand plan asserts the `coven` block exactly).
- `--tint: color-mix(in srgb, var(--text-1) 5%, transparent)`, `--tint-strong` at `9%`, `--hairline` at `11%`.
- Nothing is circular or pill-shaped except status dots, progress dots and spinners.
- The sweep covers `apps/desktop/src/renderer`, `apps/web/src` and `apps/store-desktop/src`. `apps/site` (the landing page) is not touched.
- Every existing confirmation sentence keeps all of its facts, split across title, body, path and facts. No fact is dropped and none is invented.
- Strings shown in Streamer Mode keep going through `privateLabel` where they do today (thread delete, discard changes).
- No behavior change beyond the confirmation surface: the same actions run on accept, nothing runs on cancel.
- Repo rules (`AGENTS.md`): work in the `chat-refresh-foundation` worktree, signed commits, PR, `pnpm build && pnpm test && pnpm test:e2e` green before merge, `docs/status.md` updated in the PR.

## Review Focus

1. **A confirm opened from inside Settings** (Reset learning, Remove connection). Settings traps Tab and closes on Escape with a capture listener on `document`. Expected: Escape cancels only the confirm, Tab stays inside the confirm, Settings stays open. Pinned in Task 3 (e2e "a confirm over Settings…").
2. **Two confirmations requested at once** (a second action fires while one is open). Expected: they are answered one at a time, first in first out; neither is lost. Pinned in Task 2 (unit).
3. **A keyboard shortcut pressed while a confirm is open** (⌘N, ⌘J, ⌘.). Expected: nothing behind the dialog reacts. Pinned in Task 3 (e2e).
4. **The element that opened the confirm is gone when it closes** (a menu row that unmounts). Expected: no error; focus falls back to the message box or stays on the body. Pinned in Task 3 (e2e delete from the thread menu).
5. **A circle that should stay a circle** (status dot, spinner, switch thumb is not one). Expected: dots and spinners keep `50%`; the count per file is pinned so a new circle is a deliberate edit. Pinned in Task 1.

---

### Task 1: Radius scale and tint tokens

**Files:**
- Modify: `apps/desktop/src/renderer/tokens.css` (base `:root`)
- Modify: every `*.css` under `apps/desktop/src/renderer`, `apps/web/src`, `apps/store-desktop/src`
- Modify: `apps/desktop/e2e/layout.spec.ts:114,168,203,223,245,266`
- Modify: `apps/desktop/design/tokens.md` (new section "Radius scale")
- Create: `scripts/test/radius-scale.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: CSS custom properties `--radius-xs` (4px), `--tint`, `--tint-strong`, `--hairline`; changed values for `--radius-row` (6px), `--radius-md` (8px), `--radius-composer` (8px), `--radius-sheet` (8px), `--radius-pill` (6px). `--radius-sm` stays 6px.

- [ ] **Step 1: Write the failing test** in `scripts/test/radius-scale.test.mjs`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = new URL('../../', import.meta.url).pathname;
const DIRS = ['apps/desktop/src/renderer', 'apps/web/src', 'apps/store-desktop/src'];
const files = DIRS.flatMap((dir) => fs.readdirSync(path.join(root, dir), { recursive: true })
  .filter((f) => f.endsWith('.css')).map((f) => path.join(dir, f)));
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const radii = (css) => [...css.matchAll(/border(?:-(?:top|bottom)-(?:left|right))?-radius:\s*([^;}]+)/g)].map((m) => m[1].trim());
const TOKEN = /^var\(--radius-(xs|sm|row|md|composer|sheet|pill)\)$/;
const PART = (v) => TOKEN.test(v) || ['0', '1px', '2px', 'inherit', '50%'].includes(v);

test('the scale is 8 px surfaces, 6 px controls, 4 px parts', () => {
  const base = read('apps/desktop/src/renderer/tokens.css').match(/:root\s*\{([^}]*)\}/)[1];
  const token = (name) => base.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim();
  assert.deepEqual(
    ['--radius-xs', '--radius-sm', '--radius-row', '--radius-md', '--radius-composer', '--radius-sheet', '--radius-pill'].map(token),
    ['4px', '6px', '6px', '8px', '8px', '8px', '6px']);
  assert.equal(token('--tint'), 'color-mix(in srgb, var(--text-1) 5%, transparent)');
  assert.equal(token('--tint-strong'), 'color-mix(in srgb, var(--text-1) 9%, transparent)');
  assert.equal(token('--hairline'), 'color-mix(in srgb, var(--text-1) 11%, transparent)');
});

test('no theme block redefines a radius or tint token', () => {
  const css = read('apps/desktop/src/renderer/tokens.css');
  for (const [, block] of css.matchAll(/:root\[data-theme="[a-z]+"\]\s*\{([^}]*)\}/g)) assert.doesNotMatch(block, /--(radius|tint|hairline)/);
});

test('every radius in the renderer is a token, a hairline value or a dot', () => {
  for (const file of files) for (const value of radii(read(file))) {
    assert.ok(value.split(/\s+/).every(PART), `${file}: border-radius: ${value}`);
  }
});

test('circles are limited to dots, spinners and markers', () => {
  // A new circle is a deliberate edit to this table.
  const CIRCLES = { 'apps/desktop/src/renderer/styles.css': 6, 'apps/desktop/src/renderer/usage/usage.css': 3,
    'apps/desktop/src/renderer/space/knowledge.css': 1, 'apps/desktop/src/renderer/workspace.css': 1, 'apps/store-desktop/src/renderer/store.css': 2 };
  const found = Object.fromEntries(files.map((f) => [f, radii(read(f)).filter((v) => v === '50%').length]).filter(([, n]) => n > 0));
  assert.deepEqual(found, CIRCLES);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test scripts/test/radius-scale.test.mjs`
Expected: FAIL on the first test with `'10px'` for `--radius-row`.

- [ ] **Step 3: Change the tokens**

In base `:root` of `tokens.css`: set the five changed radius tokens, add `--radius-xs: 4px;` before `--radius-sm`, and add the three tint tokens after `--rule`. Update each token's trailing comment to say "radius scale" instead of "measured".

- [ ] **Step 4: Sweep the stylesheets**

Replace each hard-coded radius by value, per component of a multi-value radius:

| Was | Becomes |
| --- | --- |
| `12px` and larger, except 15 and 17 | `var(--radius-md)` |
| `6px` to `11px`, and `15px`, `17px` | `var(--radius-sm)` |
| `3px` to `5px` | `var(--radius-xs)` |
| `999px` | `var(--radius-pill)` |
| `0`, `1px`, `2px`, `inherit` | unchanged |
| `50%` on a dot, spinner or marker (the selectors counted in the test) | unchanged |
| `50%` on a button, avatar or icon tile 18 px or larger | `var(--radius-sm)`; `.failure-icon`, `.space-comment-start svg`, `.st-switch::after` use `var(--radius-xs)` |

Rewrite the comment above `.icon-btn.send-btn` in `styles.css`: the send button is a 34 px square with the control radius.

- [ ] **Step 5: Update the layout assertions**

`layout.spec.ts`: `"--radius-row": "6px", "--radius-composer": "8px"` (line 114); sheet `"8px"` (168); thread row `"6px"` (203); composer box `"8px"` (223); send `"6px"` (245); bubble `"8px"` (266).

- [ ] **Step 6: Record the scale in `apps/desktop/design/tokens.md`**

Add a "Radius scale" section: the three steps, their tokens and old values, the rule that only dots and spinners are round, and that `scripts/test/radius-scale.test.mjs` enforces it.

- [ ] **Step 7: Run the test**

Run: `node --test scripts/test/radius-scale.test.mjs`
Expected: PASS, 4 tests.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/renderer apps/web/src apps/store-desktop/src apps/desktop/e2e/layout.spec.ts apps/desktop/design/tokens.md scripts/test/radius-scale.test.mjs
git commit -S -m "feat(ui): one radius scale and tint tokens across the renderer"
```

---

### Task 2: Confirm store

**Files:**
- Create: `apps/desktop/src/renderer/confirm.ts`
- Create: `apps/desktop/test/confirm.test.ts`

**Interfaces:**
- Consumes: nothing. The file imports no DOM or React type, so `tsconfig.main.json` can compile it for the unit test.
- Produces:

```ts
export type ConfirmTone = "neutral" | "warn" | "danger";
export type ConfirmIcon = "info" | "alert" | "trash" | "changes" | "restart" | "folder" | "stack";
export interface ConfirmFact { kind: "kept" | "lost"; text: string }
export interface ConfirmOptions { title: string; body?: string; path?: string; facts?: ConfirmFact[]; confirmLabel: string; tone?: ConfirmTone; icon?: ConfirmIcon }
export interface ConfirmRequest extends ConfirmOptions { id: number }
export function confirmDialog(options: ConfirmOptions): Promise<boolean>;
export function currentConfirm(): ConfirmRequest | null;       // the oldest unanswered request; stable identity until it settles
export function settleConfirm(id: number, accepted: boolean): void; // ignores an id that is not current
export function subscribeConfirm(listener: () => void): () => void;
export function resetConfirms(): void;                          // settles every pending request as false
export const YOLO_CONFIRM: ConfirmOptions;                      // the YOLO question, shared by the composer and the approval card
```

- [ ] **Step 1: Write the failing test** in `apps/desktop/test/confirm.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { confirmDialog, currentConfirm, resetConfirms, settleConfirm, subscribeConfirm } from "../src/renderer/confirm.js";

const ask = (title: string) => confirmDialog({ title, confirmLabel: "OK" });

test("a request is current until it is settled, and resolves with the answer", async () => {
  resetConfirms();
  const answer = ask("one");
  const current = currentConfirm()!;
  assert.equal(current.title, "one");
  assert.equal(currentConfirm(), current, "stable identity for useSyncExternalStore");
  settleConfirm(current.id, true);
  assert.equal(await answer, true);
  assert.equal(currentConfirm(), null);
});

test("requests are answered one at a time, first in first out", async () => {
  resetConfirms();
  const first = ask("first"), second = ask("second");
  assert.equal(currentConfirm()!.title, "first");
  settleConfirm(currentConfirm()!.id, false);
  assert.equal(await first, false);
  assert.equal(currentConfirm()!.title, "second");
  settleConfirm(currentConfirm()!.id, true);
  assert.equal(await second, true);
});

test("settling an id that is not current changes nothing", async () => {
  resetConfirms();
  const answer = ask("only");
  const id = currentConfirm()!.id;
  settleConfirm(id + 1, true);
  assert.equal(currentConfirm()!.id, id);
  settleConfirm(id, true); settleConfirm(id, false);
  assert.equal(await answer, true);
});

test("listeners hear every change, and reset answers everything with false", async () => {
  resetConfirms();
  let calls = 0;
  const stop = subscribeConfirm(() => { calls++; });
  const a = ask("a"), b = ask("b");
  assert.equal(calls, 1, "the second request does not change what is current");
  resetConfirms();
  assert.deepEqual(await Promise.all([a, b]), [false, false]);
  assert.equal(calls, 2);
  stop();
  void ask("c");
  assert.equal(calls, 2);
  resetConfirms();
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/desktop && pnpm run build:main && node --test dist/test/confirm.test.js`
Expected: FAIL; the module does not exist.

- [ ] **Step 3: Implement `confirm.ts`** with the signatures above: a module-level queue of `{ request, resolve }`, a `Set` of listeners, ids from a counter. Listeners are told only when `currentConfirm()` changes.

- [ ] **Step 4: Run the test**

Run: the same command. Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/confirm.ts apps/desktop/test/confirm.test.ts
git commit -S -m "feat(ui): confirm request store"
```

---

### Task 3: Confirm dialog and its ten call sites

**Files:**
- Create: `apps/desktop/src/renderer/components/ConfirmDialog.tsx`
- Modify: `apps/desktop/src/renderer/components/ui/Icon.tsx` (add `alert`)
- Modify: `apps/desktop/src/renderer/styles.css` (confirm styles)
- Modify: `apps/desktop/src/renderer/App.tsx` (mount `ConfirmHost`; lines 893, 922, 940, 971)
- Modify: `components/Composer.tsx:330`, `components/ThreadView.tsx:491`, `components/SettingsDialog.tsx:217`, `components/LocalModelsSettings.tsx:118`, `routines/RoutinesView.tsx:176,321`
- Modify: `apps/desktop/e2e/support.ts` (helper)
- Modify: `e2e/settings-transactions.spec.ts:78,295`, `project-remove.spec.ts:58,70,87`, `review.spec.ts:216-221,376-380`, `local-models.spec.ts:125`, `local-model-acceptance.spec.ts:132-139`, `terminal.spec.ts:169`, `sidebar-workspaces.spec.ts:10,43`, `approval-policy.spec.ts:41-46`
- Create: `apps/desktop/e2e/confirm-dialog.spec.ts`

**Interfaces:**
- Consumes: Task 2's store; Task 1's tokens.
- Produces: `ConfirmHost(): JSX.Element | null`, rendered once inside `App`. Test ids: `confirm-dialog` (the `role="alertdialog"` element, with `data-tone`), `confirm-title`, `confirm-body`, `confirm-path`, `confirm-fact` (each has `data-kind`), `confirm-cancel`, `confirm-accept`. E2E helper `answerConfirm(page: Page, answer: "accept" | "cancel", text?: string | RegExp): Promise<void>`: waits for the dialog, optionally asserts it contains `text`, clicks the button, waits for the dialog to go.

Confirmation copy, exact. Tone and icon in brackets; `facts` as kept (✓) or lost (✕).

| Site | Title | Body | Facts and path | Button |
| --- | --- | --- | --- | --- |
| YOLO (Composer, ThreadView) [warn, alert] | Turn on YOLO for this thread? | Every action in this thread is approved without asking, including access outside the sandbox. | ✓ Your Never rules still refuse. | Turn on YOLO |
| Cloud model (`App.tsx:893`) [neutral, stack] | Use cloud model `${cloud.label}`? | Future messages will go to that model in a fresh conversation. | path `${cloud.id}`; ✓ Existing messages will stay in the transcript. | Use cloud model |
| Delete thread with worktree (`:922`) [danger, trash] | Delete this thread and remove its worktree? | none | path `privateLabel(t.worktree.path)`; ✕ Uncommitted changes there will be lost. ✓ `privateLabel(\`The branch ${t.worktree.branch} is kept.\`)` | Delete thread |
| Remove project (`:940`) [warn, folder] | Remove this project from Modex? | none | ✓ Files on disk are not touched. ✓ Its notes stay in Space. (second only when `spaceEnabled`) | Remove project |
| Discard changes (`:971`) [danger, changes] | `privateLabel(\`Discard changes to ${path}?\`)` | This cannot be undone. | none | Discard changes |
| Reset learning (Settings) [danger, restart] | Reset Auto routing's learned preferences? | This applies immediately and cannot be undone. | none | Reset learning |
| Remove connection (Local models) [danger, trash] | Remove `${c.label}`? | Choose another model before sending on a thread that used this connection. | ✓ Past conversations stay readable. | Remove connection |
| Delete task (Routines, both) [danger, trash] | Delete the task “`${name}`”? | none | ✓ Its runs stay in All activity. ✓ Its page stays in Space. | Delete task |

- [ ] **Step 1: Write the failing e2e spec** `apps/desktop/e2e/confirm-dialog.spec.ts`

Launch with `seedHome()` and `launch(home)`, one project. Tests:

```ts
test("removing a project asks in the app, Cancel has focus, and cancelling changes nothing", async () => {
  let native = 0; page.on("dialog", (d) => { native++; void d.dismiss(); });
  await tid(page, "project").first().hover(); await tid(page, "project-menu").first().click(); await tid(page, "project-remove").click();
  const dialog = tid(page, "confirm-dialog");
  await expect(dialog).toHaveAttribute("role", "alertdialog");
  await expect(dialog).toHaveAttribute("data-tone", "warn");
  await expect(tid(dialog, "confirm-title")).toHaveText("Remove this project from Modex?");
  await expect(tid(dialog, "confirm-fact").first()).toHaveText("Files on disk are not touched.");
  await expect(tid(dialog, "confirm-cancel")).toBeFocused();
  await page.keyboard.press("Tab"); await expect(tid(dialog, "confirm-accept")).toBeFocused();
  await page.keyboard.press("Tab"); await expect(tid(dialog, "confirm-cancel")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(tid(page, "project")).toHaveCount(1);
  expect(native).toBe(0);
});

test("shortcuts do nothing behind an open confirm", async () => {
  // open the same confirm, press Meta+j and Meta+n, assert changes-panel visibility and draft-view are unchanged, then cancel
});

test("a confirm over Settings: Escape cancels the confirm and Settings stays open", async () => {
  // open-settings, click "Reset learning…" when the button exists (skip when routing has nothing to reset),
  // Escape, expect confirm-dialog count 0 and tid(page, "settings") visible
});

test("accepting runs the action once and the dialog closes", async () => {
  // project-remove, answerConfirm(page, "accept", "Remove this project"), expect project count 0
});
```

The two outlined tests assert exactly what their comments say.

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/desktop && pnpm run build && pnpm exec playwright test e2e/confirm-dialog.spec.ts`
Expected: FAIL; `confirm-dialog` never appears.

- [ ] **Step 3: Add the `alert` icon** to `PATHS` in `ui/Icon.tsx`: `alert: "M8 2.5l6 10.5H2zM8 6.5v3M8 11.25h.01"`.

- [ ] **Step 4: Implement `ConfirmHost` in `components/ConfirmDialog.tsx`**

`useSyncExternalStore(subscribeConfirm, currentConfirm)`; render nothing without a request; otherwise `createPortal` to `document.body`:

- Backdrop `.modal-backdrop.confirm-backdrop`; a pointer down on the backdrop itself cancels.
- Dialog `.modal.confirm.tone-<tone>` with `role="alertdialog"`, `aria-modal="true"`, `aria-labelledby`, `aria-describedby` (body when present, else title), `data-tone`.
- Default tone `neutral`; default icon `info`. The accept button is `.btn.primary` for neutral, `.btn.solid-warn` or `.btn.solid-danger` otherwise.
- On mount (keyed by request id): remember `document.activeElement`, focus Cancel. On unmount: focus the remembered element when it is still connected.
- One capture listener on `window` for `keydown` while open: Escape cancels; Tab and Shift+Tab move between the two buttons; every key event has `stopPropagation()` called so nothing behind the dialog handles it. Default actions are left alone, so Enter and Space still press the focused button.

- [ ] **Step 5: Add the styles** to `styles.css` after the `.modal` rules: the confirm block from the prototype stylesheet (`claude/chat-refresh/prototype/proposed.css`, section "Confirm dialog" and the `.confirm .btn` rules), unscoped, with radii as `var(--radius-md)` and `var(--radius-sm)`. Add `forced-colors` and `prefers-reduced-motion` rules: no animation; borders `CanvasText`.

- [ ] **Step 6: Mount it** as the last child of `App`'s root element in `App.tsx`: `<ConfirmHost />`.

- [ ] **Step 7: Replace the ten calls** with `confirmDialog({...})` using the copy table. Synchronous handlers become `void confirmDialog(...).then((ok) => { if (ok) … })`; `async` ones `await` it. In `SettingsDialog.resetLearning`, check `operationRef.current` before asking and again after the answer. In `ThreadView`, YOLO keeps today's behavior: on accept it calls `onPolicy("yolo")` only.

- [ ] **Step 8: Add `answerConfirm` to `e2e/support.ts`** and update the specs listed under Files: remove each `page.once("dialog", …)` that answered a confirm and call `answerConfirm` after the click that opens it, passing the text the old handler asserted (`/Reset Auto routing's learned preferences/`, `"Discard changes to b.txt?"`, `"fixture-cloud"`). `sidebar-workspaces.spec.ts` drops its blanket handler and answers the one project removal. `approval-policy.spec.ts` drops both `window.confirm` stubs: cancel the first YOLO, accept the second.

- [ ] **Step 9: Run the specs this task touched**

Run: `cd apps/desktop && pnpm run build && pnpm exec playwright test e2e/confirm-dialog.spec.ts e2e/settings-transactions.spec.ts e2e/project-remove.spec.ts e2e/review.spec.ts e2e/local-models.spec.ts e2e/local-model-acceptance.spec.ts e2e/terminal.spec.ts e2e/sidebar-workspaces.spec.ts e2e/approval-policy.spec.ts e2e/layout.spec.ts`
Expected: PASS. Then `git grep -n "window.confirm" -- apps` prints nothing.

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/src/renderer apps/desktop/e2e
git commit -S -m "feat(ui): in-app confirm dialog replaces window.confirm"
```

---

### Task 4: Documents and the full check

**Files:**
- Create: `docs/superpowers/specs/2026-11-15-chat-prompts-refresh-design.md` (the approved design)
- Modify: `docs/status.md` ("In flight")

- [ ] **Step 1:** Add the design document and an "In flight" entry: the chat refresh, PR 1 of 5, what it changes, and that PRs 2 to 5 follow the same spec.
- [ ] **Step 2: Run everything CI runs**

Run: `pnpm build && pnpm test && pnpm test:e2e`
Expected: PASS.

- [ ] **Step 3: Commit, push, open the PR** titled "Chat refresh 1/5: radius scale, tints and in-app confirm dialog". Do not merge without Val's review.

```bash
git add docs
git commit -S -m "docs: chat refresh design, foundation plan and status"
```
