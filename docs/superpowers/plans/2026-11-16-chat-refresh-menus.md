# Chat Refresh Menus (PR 2 of 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every menu the refreshed shell, and make the composer's two menus one line per row with a single description at the foot.

**Architecture:** `Menu` and `MenuItem` each gain an optional `hint`. A row with a hint renders on one line and carries the sentence as its accessible description; a menu with a hint renders one description area at its foot and fills it from the row under the pointer or focus, by event delegation on the menu element. Menus that pass no hint keep their markup and take only the shared shell styling, so the model picker and the eleven other menus are not restructured.

**Tech Stack:** Existing TypeScript, React 19, Playwright; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-15-chat-prompts-refresh-design.md`, section "2. Menus". Stacked on PR 1 (`chat-refresh-foundation`), whose tokens it uses. The request panel's "more" menu arrives with PR 4 and uses the same props.

## Global Constraints

- A menu with a hint is `264px` wide; its rows are `32px` high; its section labels are `11px` uppercase with `.09em` letter spacing.
- The foot uses `--text-info`, because it carries information (`styles.css` reserves `--text-3` for labels).
- A row's description is never visual only: it is the row's `aria-description`. The foot is `aria-hidden`.
- The selected row of a one-line menu has a check at its right edge and medium weight, no fill. An on/off row shows a switch; its state stays the row's `aria-checked`.
- Radii come from the PR 1 scale: menu `--radius-md`, rows `--radius-sm`, switch `--radius-xs`.
- Existing `data-testid`s, roles and accessible names do not change (`access-menu`, `access-option`, `approvals-option`, `composer-plus-menu`, `plan-toggle`, `auto-toggle`, `backend-picker`; "Attach files" stays the first row's exact name).
- Menu copy is unchanged: every description sentence that exists today is the row's hint, word for word. One sentence is new: "Add files or images to your next message." for Attach files, which had none.
- No behavior change: the same handlers run, the same rows are disabled, the menus close as they do today.

## Review Focus

1. **A menu opened with the keyboard, never touched by the pointer.** Expected: the foot describes the focused row from the first frame and follows the arrow keys. Pinned in Task 2.
2. **A screen reader on a one-line row.** Expected: the description is announced from the row itself, and the foot is not read a second time. Pinned in Task 2 (`aria-description` on the row, `aria-hidden` on the foot).
3. **A menu that passes no hint** (model picker, sidebar, title bar, Changes, routines, Space, Code Review, plugins). Expected: same rows as before, no foot, selection still visible on the new surface. Pinned in Task 2 (model menu has no foot) and by the existing specs for those menus.
4. **A thread pinned to a local model.** Expected: Plan, Auto and Backend stay disabled, the pinned note still shows, and each disabled row's hint is today's pinned sentence. Covered by the existing local-model specs; the hints are the same strings.
5. **Forced colors.** Expected: the switch is visible as a bordered track and shows its on state. Pinned in the stylesheet's `forced-colors` rule; checked by review, not by a test.

---

### Task 1: `hint` on `Menu` and `MenuItem`, and the shared shell

**Files:**
- Modify: `apps/desktop/src/renderer/components/ui/Menu.tsx`
- Modify: `apps/desktop/src/renderer/styles.css` (after `.menu-title .kbd`)

**Interfaces:**
- Consumes: `--tint`, `--tint-strong`, `--hairline`, `--radius-xs` from PR 1.
- Produces:
  - `Menu` prop `hint?: string`. When defined, the menu element gains the class `has-hint` and a last child `<div class="menu-hint" data-testid="menu-hint" aria-hidden="true">`. Its text starts as `hint` each time the menu opens and becomes the `data-hint` of the closest row on `mouseover` and `focus` inside the menu.
  - `MenuItem` prop `hint?: string`. When defined, the button gains the class `compact` and the attributes `data-hint` and `aria-description`, both set to the hint. With `toggle`, it renders `<span class="menu-switch" aria-hidden="true">` in place of the check.

- [ ] **Step 1: Write the failing spec** (Task 2, Step 1, tests 1 and 3 exercise this task's props).
- [ ] **Step 2: Implement the two props** in `Menu.tsx` with the behavior above. The description state lives in `Menu`; `MenuItem` stays stateless.
- [ ] **Step 3: Add the styles**
  - Every menu: border `var(--hairline)`, background `var(--bg-elevated)`, the prototype's layered shadow, a `--duration-fast` opacity fade on open (no transform, so a menu's measured box does not move). Row hover `var(--tint)`; selected row `var(--tint-strong)`, hovered or not.
  - `.menu.has-hint`: width `264px`, label and separator as in Global Constraints.
  - `.menu-item.compact`: `32px` high, `--text-sm`, title on one line, check and switch at the right edge (`order`), selected row transparent with a medium-weight title, hover `var(--tint-strong)`.
  - `.menu-switch`: `26×16`, `--radius-xs`, thumb `10px` with a `2px` radius; on when the row has `aria-checked="true"`.
  - `.menu-hint`: `min-height: 58px` (three lines, so the menu does not resize as rows change), top border `var(--hairline)`, `--text-info`, `--text-xs`.
  - `prefers-reduced-motion`: no fade. `forced-colors`: bordered switch, `Highlight` when on.
- [ ] **Step 4: Commit** with Task 2.

---

### Task 2: The composer's menus

**Files:**
- Modify: `apps/desktop/src/renderer/components/Composer.tsx` (`PlusMenu`, `AccessMenu`)
- Create: `apps/desktop/e2e/menu-hints.spec.ts`
- Modify: `docs/status.md`

**Interfaces:**
- Consumes: Task 1's props.
- Produces: nothing later PRs depend on by name. PR 5 moves access to tabs and approvals to their own menu; the hints stay with their rows.

- [ ] **Step 1: Write the failing spec** `apps/desktop/e2e/menu-hints.spec.ts` (`seedHome()`, `launch(home)`; the seeded mode is `chat`, the backend is `mock`):

```ts
test("the access menu keeps each choice to one line and describes the focused or hovered one at its foot", async () => {
  await tid(page, "access-picker").click();
  const menu = tid(page, "access-menu");
  const option = (mode: string) => menu.locator(`[data-testid="access-option"][data-mode="${mode}"]`);
  const foot = tid(menu, "menu-hint");
  await expect(option("chat")).toBeFocused();
  await expect(foot).toHaveText("Read-only. Asks before any command or edit.");
  await expect(foot).toHaveAttribute("aria-hidden", "true");
  await expect(option("chat")).toHaveText("Read only");
  await expect(option("full-access")).toHaveAttribute("aria-description", "No sandbox, no prompts. Only in a trusted environment.");
  expect(Math.round((await option("agent").boundingBox())!.height)).toBe(32);
  await page.keyboard.press("ArrowDown");
  await expect(option("agent")).toBeFocused();
  await expect(foot).toHaveText("Edits and runs commands inside the project; asks to go outside it.");
  await option("full-access").hover();
  await expect(foot).toHaveText("No sandbox, no prompts. Only in a trusted environment.");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(tid(page, "access-picker")).toBeFocused();
});

test("the + menu shows Plan and Auto as switches and describes each row", async () => {
  // composer-plus; "Attach files" focused with its hint; ArrowDown to plan-toggle and its hint;
  // plan-toggle is a menuitemcheckbox, aria-checked "false", with one switch and no description text in the row;
  // hover auto-toggle; the checked backend reads "Mock" and carries "Offline scripted engine (demo)" as its description; Escape.
});

test("a menu without hints has no foot", async () => {
  // model-picker; model-menu visible; menu-hint count 0 inside it; Escape.
});
```

The two outlined tests assert exactly what their comments say, with these strings: "Add files or images to your next message.", "Investigate read-only and return a plan instead of editing.", "A fast judge picks the model, effort and speed for each turn, within your limits."

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/desktop && pnpm run build && pnpm exec playwright test e2e/menu-hints.spec.ts`
Expected: FAIL; `menu-hint` does not exist.

- [ ] **Step 3: `AccessMenu`**: pass `focusSelected` and `hint={info?.hint ?? ""}` to `Menu`; add `<MenuLabel>Access</MenuLabel>` above the modes; each mode row gets `hint={m.hint}` and each approvals row `hint={APPROVAL_HINT[p]}`; each row's child is `<span className="menu-title">` with the label only.
- [ ] **Step 4: `PlusMenu`**: `hint` on the menu is the Attach files sentence; Attach files, Plan mode, Auto routing and each backend row get their hint (the pinned sentences when `pinned`; `b.hint` for a backend, replacing its `title`); each row's child is the title span only, with the `⇧⌘P` key hint inside Plan mode's.
- [ ] **Step 5: Run the specs this PR touches**

Run: `cd apps/desktop && pnpm run build && pnpm exec playwright test e2e/menu-hints.spec.ts e2e/app.spec.ts e2e/approval-policy.spec.ts e2e/layout.spec.ts e2e/local-models.spec.ts`
Expected: PASS.

- [ ] **Step 6: Update `docs/status.md`** ("In flight": PR 2 of 5), then run `pnpm build && pnpm test && pnpm test:e2e`. Expected: PASS.
- [ ] **Step 7: Commit, push, open the PR** against `chat-refresh-foundation`, titled "Chat refresh 2/5: one-line menus with a description at the foot". Do not merge without Val's review.

```bash
git add apps/desktop/src/renderer apps/desktop/e2e docs
git commit -S -m "feat(ui): one-line menus with a description at the foot"
```
