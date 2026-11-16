# Modex chat and prompts refresh: design

Status: **approved by Val on 2026-11-15** on a throwaway prototype (a private page, not in this
repository). Written against `TypeSafeAI/modex` at `538d357`. PR 1 of 5 (radius scale, tints and
the confirm dialog) is implemented by
[`plans/2026-11-15-chat-refresh-foundation.md`](../plans/2026-11-15-chat-refresh-foundation.md);
PRs 2 to 5 each get their own plan from this document. Measurements below come from the
prototype's stylesheet; a later PR copies the rules it needs from this document's values.

## Intent

Val finds the chat, the approval prompts and the confirmation boxes clunky and unpolished, and
wants them to read like a modern coding-chat application: minimal, sleek and consistent. The
work is visual and structural. It changes how requests, menus and the composer are laid out. It
does not change what Modex can do, what is asked, or who decides.

## Goals

1. Approval and question requests are answered in one quiet panel joined to the composer.
2. Every confirmation uses one in-app dialog. The browser's `confirm` box is gone.
3. Menus are one line per row, with a single description at the foot.
4. The composer is one box: access as tabs (top left), where the thread runs (top right),
   titled options along the bottom.
5. Transcript rows (thinking, tools, receipts) share one row style; the reading column and the
   composer share one width.
6. All three themes (graphite, Jev, OpenCoven) get it, in the desktop app, the Store edition
   and the web demo, because they share `apps/desktop/src/renderer`.

## Non-goals

- The shell's layout: sidebar, rail, title bar, Changes, terminal, Settings. (The radius scale
  below does reach them, because Val asked for one radius everywhere.)
- New capabilities, new approval semantics, or any change to what main validates.
- Restructuring the model picker (search, groups, effort). It takes the new row styling only.
- The iPhone companion.
- A setting that keeps the old interface.

## Anti-goals

- A request that is easier to approve by accident than today.
- A command, path or diff that is cut short in the place where it is approved.
- A request state that exists today and has no place in the new panel (see "States").
- Copying another product's layout. The prototype is Modex's own, in Modex's tokens.

## Constraints found in the code

- **An approval carries no structure.** A thread item has `question` (the CLI's sentence, such
  as "Allow command: npm test?"), `detail` (preformatted text), `canAlways`, and `title` only
  when a rule answered it. Main does hold more (`ApprovalAction`: `tool`, `title`, `cwd`,
  `escalation`), but it does not reach the item. The prototype's "RUN COMMAND" label, bare
  command line and diff assume fields that do not exist yet.
- `Composer` also serves `DraftView` (a new chat): no approvals policy there, and Local/Worktree
  is a toggle.
- `ui/Menu` is used by 13 components. A global `.menu` restyle reaches all of them.
- `window.confirm` is called in 10 places (YOLO twice, cloud model, delete thread, remove
  project, discard changes, reset routing, remove local connection, delete task twice).
- `e2e/layout.spec.ts` pins the composer at 960×109, its context strip and control insets, and
  `design/tokens.md` records them as deliberate. About 40 spec and test files use the affected
  test ids; 25 Playwright `dialog` handlers exist, and `approval-policy.spec.ts` stubs
  `window.confirm`.
- `keyboard-answers.spec.ts` pins where focus goes after an answer (a CF-8 accessibility
  finding). ⌘⏎ outside the message box already means "focus the message box" (`App.tsx`).
- `styles.css` reserves `--text-3` and `--text-4` for labels and decoration; small text that
  carries information uses `--text-info`.
- The Phase 1 brand plan asserts the `coven` token block exactly, so new tokens belong in the
  base `:root` only.
- `AGENTS.md`: worktree per session, signed commits, PR, `pnpm build && pnpm test`, and
  `pnpm test:e2e` for UI changes; `docs/status.md` updated in the PR.

## Approaches

| | Approach | Trade-off |
| --- | --- | --- |
| **A (chosen)** | In place, one surface per PR, five PRs | Slower to finish; each step is reviewable, shippable, and touches only its own tests |
| B | Behind a "new chat interface" setting | Safe rollout, but two markup paths and two test matrices while the switch exists |
| C | One large PR | Least sequencing; about 40 test files at once, and it collides with the brand plan in the same stylesheets |

Val steered by outcome and left the how to the builder, so A is the builder's call, stated to
Val on 2026-11-15.

## Design

### Shared: tokens and buttons

Three derived tokens in base `:root` of `tokens.css`, so every theme inherits them:
`--tint` (5% of `--text-1`), `--tint-strong` (9%), `--hairline` (11%). One reading width,
`--chat-col: 760px` (down from 938). Buttons inside requests and dialogs are 32 px tall: one
filled (`--accent-strong` on `--accent-ink`), the rest plain text with a tint on hover.

**One radius scale, for every button and component** (Val, 2026-11-15: less rounded, uniform).

| Step | Value | Used for | Token |
| --- | --- | --- | --- |
| Surface | 8 px | Composer, request panel, menus, dialogs, user bubble, code blocks, the content sheet | `--radius-md`, `--radius-composer`, `--radius-sheet` (were 12, 20, 12) |
| Control | 6 px | Buttons, send and stop, icon buttons, rows, options, fields, the tab track | `--radius-sm`, `--radius-row`, `--radius-pill` (were 6, 10, 999) |
| Part | 4 px | Tabs, icon tiles, the switch, inline code, key hints, status chips | `--radius-xs` (new) |

Nothing is pill-shaped or circular except status and progress dots. `styles.css` has 127
radius declarations and 91 are hard-coded numbers; all of them move onto these three tokens, so
the scale holds across the whole app and not only on the surfaces this project lays out.

### 1. Confirm dialog

One `ConfirmDialog` component and a `useConfirm()` hook returning a promise, replacing all 10
`window.confirm` calls. Contents: an icon tile in the tone of the action (warn for YOLO, danger
for destructive), a question as the title, one sentence of consequence, an optional path in
monospace, and an optional list of what is lost and what is kept. Cancel has focus when it
opens; the action button names the action ("Delete thread", "Turn on YOLO", "Discard changes").
Escape and the backdrop cancel; focus is trapped and returns to the opener. `role="alertdialog"`.
The existing sentences are kept and split across title, consequence and facts; no fact is
dropped.

### 2. Menus

`.menu` becomes 264 px wide with the surface radius, a hairline border and 32 px single-line rows.
The selected row carries a check at the right and medium weight, no fill. Section labels are
11 px uppercase. `MenuItem` gains a `hint` prop; a menu with any hint renders one description
area at its foot showing the hint of the row under the pointer or focus (the selected row's
when it opens). Each row also carries its hint as `aria-description`. Toggles render as a small
switch. In this project the hint foot is used by the approvals menu, the `+` menu and the
request's "more" menu; other menus take the shell and row styling and keep their content.

### 3. Transcript

- Each turn is wrapped in one element (`TurnContent` returns a fragment today) so spacing and
  hover can be scoped to a turn.
- "Worked for 38s" loses its rule and becomes a small inline toggle; a live turn shows a dot
  (amber while waiting) and shimmer text.
- Thinking, tool and receipt rows: 34 px, a 22 px icon tile, verb plus monospace target
  ("Ran `npm test`"), meta at the right. Tool glyph characters become icons from `ui/Icon`.
- Every human answer becomes a receipt row ("Approved `$ npm test` · by you"), the form rules
  already use. Expanded, it shows the question and detail as today.
- User bubble: the surface radius on all four corners. Reply actions show on hover or
  focus within the turn, and always on the newest turn.
- A streaming reply ends in a pulsing dot. "Jump to latest" is a square icon button with a
  hidden text label.

### 4. Request panel

A `RequestDock` rendered by `ThreadView` directly above the composer (and above the retired or
archived notice when there is no composer). It shows the oldest unanswered request; when more
are waiting, the label reads "1 of 3". The transcript shows no card for a pending request: the
turn status line says "Waiting for approval" and the panel is always in view.

Layout: a small uppercase label, then the subject, then the answer at the right. A one-line
subject and its buttons share a row; anything longer puts the buttons on their own row. The
panel and the composer share the surface radius and the same background, 6 px apart. The panel
animates in once per request, not each time its contents redraw.

**Approval, first cut (renderer only).** Label "Approval". Subject: `question` as text, then
`detail` in monospace, wrapped, scrolling past 132 px, never truncated. When a rule sent it to
a person, the existing "asked because" line shows under the subject.

**Approval, second cut (small engine change).** The runner copies three display-only fields
from `ApprovalAction` onto every approval item: `title`, `cwd` and `subject`
(`"command" | "edit" | "permissions" | "tool"`), all optional. They are never read back for a
decision, and the action digest is unchanged. With them the label reads "Run command · in
~/code/app" with the command as the subject, or "Edit file" with `detail` rendered by the
existing `Patch` component when it parses as one. Items without the fields (old threads) keep
the first-cut form. A permissions request is labelled "Extra access" in the warn tone.

Controls: **Approve** (filled), **Deny** (text), and a "more" button opening: "Always allow
this command" (only when `canAlways`), "Always allow in this thread", and "YOLO…", which opens
the confirm dialog. The handlers are today's, unchanged.

**Question.** Label "Question" (or "Question 1 of 2"), the header, the text, then borderless
numbered rows, one per option, with the description on the same line. When `allowOther`, the
last row is a text field; typing in it selects it. A question without options is a single
field; a secret one is a password field. Several questions stack in the panel, which scrolls
past half the window height. One **Send** button, disabled until every question has an answer.
Main's refusal reasons show beside Send in the danger tone. Drafts keep using
`QuestionDraftContext`.

### 5. Composer

One box, three rows.

- **Top left:** access as a segmented control (Read only, Agent, Full access), a radio group
  with arrow-key movement. Each tab is an icon (eye, agent, open lock). Its word slides out
  beside the icon over the base duration when the tab is selected, hovered or keyboard-focused,
  and slides back otherwise, so at rest only the selected tab shows its word. The name is always
  the tab's accessible label, and the mode's description stays its tooltip. Full access is
  orange and shows "No sandbox, no prompts" beside it. `ui/Icon` gains `eye` and `unlock`;
  `agents` exists.
- **Top right:** project, Local or Worktree, and branch as a caption. In a draft, Local/Worktree
  stays a button.
- **Middle:** the message field (44 px minimum, 180 px maximum).
- **Bottom:** `+` (Attach files, Backend); "Approvals *value*" opening the approvals menu,
  absent in a draft; Plan and Auto as inline toggles that tint when on; then "Model *value
  effort*" and the square send or stop button.

The context strip above the box and the Plan, Auto and approvals chips go away: the controls
show their own state. Below 640 px of composer width the titles, the caption beside the tabs
and all but the branch drop out (a container query; this covers the Space chat panel). For a
thread pinned to a local model, Plan, Auto and Backend are disabled with the existing note as
their tooltip.

## States the prototype did not show

| State today | In the new design |
| --- | --- |
| `delivery: "sending"` | The panel stays, buttons disabled, label "Sending decision…" |
| `delivery: "uncertain"` | Receipt row stays visible, warn tone, "Delivery uncertain — not resent" |
| `withdrawn` (native, stopped, ended) | Neutral receipt row with the existing sentence |
| Rule or policy answered | Receipt row, as today |
| Question refused by main | Message beside Send; the panel stays open |
| Thread retired or archived | No panel can be pending; receipts read as elsewhere |
| Reduced motion, forced colors | No entrance or pulse animation; borders fall back to system colors |

## Keyboard, focus and accessibility

- ⌘⏎ approves, or sends a complete answer, only while a request is waiting, the message box has
  no unsent text, and the request has been on screen for at least 400 ms. Otherwise ⌘⏎ keeps
  today's meaning. Number keys pick a question option when focus is not in a field.
- After an answer, focus moves to the message box and a polite live region announces the result
  ("Approved", "Denied", "Answer sent"). This replaces today's move to the card's answer line
  and updates `keyboard-answers.spec.ts` deliberately.
- Information-bearing small text (menu hint, "in ~/code/app", option descriptions) uses
  `--text-info`. A unit test checks 4.5:1 for each new text and surface pair in every theme.

## Tests

- Existing `data-testid`s stay on the element that keeps the meaning (`approval-question`,
  `approval-answer`, `approval-reason`, `question-submit`, `access-picker` (now the tab group),
  `access-option`, `approvals-option`, `composer-box`, `composer-input`, `send`, `stop`,
  `turn-label`). Ids for removed elements
  (`composer-context`, the three chips) are retired with their assertions.
- `layout.spec.ts` composer geometry and `design/tokens.md` are rewritten to the new numbers in
  the composer PR. Its radius assertions (`--radius-row: 10px`, `--radius-composer: 20px`, the
  box's 20 px corner) change with the radius scale in the first PR.
- A `confirmWith(page, "accept" | "cancel")` helper in `e2e/support.ts` replaces each
  `dialog` handler that answered a confirm; guards that only dismiss stray dialogs stay.
- New: confirm dialog focus and Escape; menu hint follows hover and focus; the panel's states
  from the table above; the ⌘⏎ guards; the 640 px composer breakpoint; old thread items without
  the display fields.

## Sequence

1. Tokens (tints, hairline, the radius scale and the sweep of hard-coded radii), buttons, the
   confirm dialog and its 10 call sites.
2. Menus (`Menu`, `MenuItem` hint, switch) and the composer's menus.
3. Transcript: turn wrapper, rows, receipts, bubble, reply actions.
4. Request panel, first cut; then the engine's display fields and the second cut.
5. Composer, with `layout.spec.ts` and `design/tokens.md`.

Each PR updates `docs/status.md`. The work is independent of the brand-system plan apart from
shared files; whichever lands second rebases.

## Left to the builder

Component file layout; exact easing; whether the hint foot reserves two or three lines per
menu; how `Patch` detection decides that `detail` is a diff; test names.

## Calls made by the builder, for Val to check

1. Approach A, five PRs.
2. The request panel ships in two cuts because of the missing structure.
3. ⌘⏎ guards (no unsent text, 400 ms).
4. Focus goes to the message box after an answer, with a spoken result.
5. Full access is one click on a tab; its warning shows after selection and as a tooltip. The
   unselected tabs are icons only until hovered or focused.
6. The reading column narrows to 760 px.
7. The model picker is restyled, not restructured.
8. Several pending requests are answered one at a time, oldest first.
9. The radius scale is applied app-wide, including Settings, the sidebar and Code Review, which
   this project otherwise leaves alone.
