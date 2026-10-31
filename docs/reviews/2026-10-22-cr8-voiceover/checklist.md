# Keyboard and VoiceOver review of Code Review, 2026-10-22

This is the human gate for [#327](https://github.com/TypeSafeAI/modex/issues/327) (CR-8) and for
[#322](https://github.com/TypeSafeAI/modex/issues/322) AC4. A person drives the Code Review surface with
the keyboard alone, then with VoiceOver, and records what they hear. The automated checks in
`e2e/code-review-a11y.spec.ts` and `e2e/code-review-navigation.spec.ts` measure contrast, Tab reach, focus
rings and Escape. They do not replace this review. The
[acceptance matrix](../2026-10-22-cr8-acceptance-matrix.md) lists this gate as open until it is filled in.

It covers what CR-3 built: the inbox, the PR and Changes tabs, the header actions, the split and the dividers,
and, since the overview (#323) and the diff and file tree (#324) landed, parts C and D for the populated panes.
The review panel and instructions popover (#325) and the GitHub writes (#326) have landed too; their rows stay
listed at the end for their own issues' acceptance and are not part of #322 AC4.

**Build:** `main` at `afec85b` (#438, the CR-3 acceptance follow-up) or later, built with `pnpm build`. On
2026-10-30 `main` was `f51ef7e`; the automated half of this gate was re-run there
([resume record](../2026-10-30-cr3-acceptance-resume.md)). Record the SHA you used. The automated half's first run
is in [the CR-3 acceptance record](../2026-10-28-cr3-acceptance.md).

## Setup (about 3 minutes)

Use synthetic data and no GitHub login. The same harness as the `F-prod` specs: a throwaway home, a
synthetic `gh` first on PATH, and no tokens. The person's own `gh` login is never read.

```sh
# from apps/desktop, in a worktree at the SHA under test, after pnpm build
node ../../docs/reviews/2026-10-22-cr8-voiceover/seed.mjs /tmp/modex-cr8-voiceover   # prints the command to run
```

The script writes the home, the synthetic `gh` and its world (the journey's three authored PRs and one to
review, all made up), and prints an `env … npx electron .` line. Run that line, then:

1. Open DevTools (View → Toggle Developer Tools) and run `localStorage.setItem("modex.codeReview", "on")`. Then reload (Command-R). This turns on the unfinished destination in a built app.
2. Make the window about 1440×900.
3. Part A runs with VoiceOver off. Part B runs with VoiceOver on (Command-F5; VO = Control-Option).
   Parts C and D run with VoiceOver on. Repeat A1–A6, C1–C3 and D1–D4 at about 900×600 and note
   anything that differs: the split folds to one pane there, and the file tree sits behind the
   **Show changed files** toggle in the Changes header.

## A. Keyboard only (no mouse or trackpad)

| # | Do | Expect | Pass? Notes |
| --- | --- | --- | --- |
| A1 | Tab to the rail's **Code Review** button and press Return | The inbox opens: "Code Review", **Inbox actions**, the search field, then "Authored by me" and "Needs my review" | |
| A2 | Tab into the list, then use Down, Up, Home and End | One Tab stop for the whole list; the arrow keys move between rows; each row shows a focus ring | |
| A3 | Press Return on "Move holds between branches…" | The PR opens: the PR tab and the **Changes +8,912 −47** tab appear in the title bar; the header reads "Open", "lending #73" | |
| A4 | Keep pressing Tab | Pin, Copy link, Open in GitHub, Review with Codex, Review instructions and Merge, then the title bar's PR tab, its close, Changes and its close, New tab, and the split button. **Note:** the title-bar tabs come after the header, though they are drawn above it. Record whether that order is acceptable. | |
| A5 | On **Review with Codex**, **Review instructions**, **Merge** and **New tab**, press Return and Space | Nothing happens; each one says why it isn't available (tooltip). Focus stays put. | |
| A6 | Tab to the split button and press Return; then Tab to the divider between the panes and press Left/Right (Shift for larger steps) | Changes opens beside the PR. The divider moves and its value changes. It stops at each pane's minimum. | |
| A7 | Inbox actions → Return → Escape | The menu opens with **Refresh** focused; Escape closes it and returns focus to **Inbox actions** | |
| A8 | Open the second PR, then use the title bar's Back and Forward | Each PR returns as you left it (split or not), without a loading spinner | |
| A9 | On the PR tab, press Right | Focus and the view move to Changes | |
| A10 | Close Changes with its close button | The PR tab stays, and focus lands on it | |
| A11 | In the search field, type `example-org/lending#73` and press Return | "Press Return to open example-org/lending #73" shows while you type; Return opens it | |
| A12 | Type `https://github.com.evil.example/example-org/lending/pull/73` and press Return | No "Press Return to open" hint and no PR opens; it is treated as search text | |

## B. VoiceOver

| # | Do | Expect to hear (roughly) | Pass? Notes |
| --- | --- | --- | --- |
| B1 | VO-Right from the rail into the inbox | "Pull request inbox, complementary"; "Code Review, heading level 1"; "Inbox actions, menu pop-up button"; "Search or paste a PR link, search text field"; "Authored by me, group" | |
| B2 | VO-Right over a row | The title, then "example-org/lending #73, ada-fixture ·" and its age. A selected row adds "current". A row that may be part of a stack adds "May be part of a stack (inferred from its base branch)". | |
| B3 | Open a PR and VO-Right through the header | "Open"; "lending #73"; while it loads, "Loading the pull request"; "Pin, toggle button"; "Copy link"; "Open in GitHub, link"; "Review with Codex, dimmed" with the reason as its description; the same for Review instructions and Merge | |
| B4 | Activate **Copy link** | "Link copied" is announced (a polite live region) | |
| B5 | VO-Right through the title bar's tabs | "…, tab, selected, 1 of 2" for the PR tab; "Changes, plus 8,912 minus 47, tab" (note how the totals are read); "Close Changes, button" | |
| B6 | Move to a divider | "Resize the pull request pane, splitter" or similar, with its value; VO-Shift-Arrow or Left/Right changes it | |
| B7 | Without moving the cursor, open a PR whose read is slow (or just watch while one loads) | Note what is announced on its own, if anything: the spinner is `role=status`. Record what you hear. | |
| B8 | Turn on Reduce motion (System Settings → Accessibility → Display), then open a PR | The header spinner stops turning | |

## C. The overview (#323), keyboard and VoiceOver

Open "Move holds between branches…" first. Its body is long enough to scroll.

| # | Do | Expect | Pass? Notes |
| --- | --- | --- | --- |
| C1 | VO-Right from the header into the pane | "Description and activity, main"; the PR title as a heading; the description's own headings and lists read as headings and lists, not as one run of text | |
| C2 | With VO off, click in the description, then press PageDown and End | Only the description column scrolls (at 1440×900 the sidebar with checks and the stack stays put; at 900×600 they stack under it and scroll together). The inbox list and the window do not move | |
| C3 | Tab to the activity filter, change it with the arrow keys, then Tab to **Load more activity** and press Return | Focus stays on the filter while the list changes; more cards arrive below without the view jumping; "All activity loaded" is announced when it is | |
| C4 | VO-Right through the sidebar | Each check reads its name and state in words ("success", "failure", "pending"), never only a colour; the stack says "Inferred from base/head branches · May be incomplete" before its list; a deployment reads its destination as a link you have to activate | |
| C5 | Scroll the inbox list with the wheel or trackpad while focus is in the description | The focused control keeps focus; the description does not move | |

## D. Changes: the diff and the file tree (#324), keyboard and VoiceOver

Press Right on the PR tab, or activate **Changes**. At 900×600, the tree is behind the **Show changed files**
toggle in the Changes header (it becomes **Show the diff** while the tree is up); at 1440×900 it sits to the
right of the diff.

| # | Do | Expect | Pass? Notes |
| --- | --- | --- | --- |
| D1 | VO-Right through the diff toolbar and the first file | "Refresh files"; "n of n files loaded"; "Wrap lines, checkbox"; "Highlight changes, checkbox"; then the file's path as a button that reads "Expand" or "Collapse", its additions and deletions in words, and "File options for …" | |
| D2 | On a file heading press Return, then VO-Right into the patch | The hunk reads line by line with its old and new line numbers; a context line, an added line and a removed line can be told apart by what is read, not by colour | |
| D3 | With VO off: focus a file heading, then press PageDown; then scroll the inbox with the wheel | Only the diff scrolls on PageDown; the inbox scroll does not move the diff or take the focus from the heading | |
| D4 | Tab into the tree's filter field ("Filter remote files"), type `move`, then Tab to the file ("View remote diff for src/holds/move.ts") and press Return | The tree narrows to the match; Return moves the diff to that file's section and focuses it; the tree keeps its own scroll position | |
| D5 | Tab back into the tree and scroll it with PageDown | Only the tree scrolls; the diff stays where D4 left it | |
| D6 | Switch to the PR tab and back to Changes | The diff, the tree and the inbox are each where you left them; the file you chose is still marked current | |

## Not part of #322 (owned by their own issues)

| Slice | Rows for that issue's human gate |
| --- | --- |
| #325 review | R3's instructions popover: its scope line, Escape returns focus to the gear; review start, stop and progress announced |
| #326 writes | Confirmation dialogs; submit announced once; reconciliation state after an uncertain write |

## Result

| Reviewer | Date | SHA | macOS / VoiceOver | Outcome |
| --- | --- | --- | --- | --- |
| | | | | |
