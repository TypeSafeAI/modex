# Keyboard and VoiceOver review of Code Review, 2026-10-22

This is the human gate for [#327](https://github.com/TypeSafeAI/modex/issues/327) (CR-8) and for
[#322](https://github.com/TypeSafeAI/modex/issues/322) AC4. A person drives the Code Review surface with
the keyboard alone, then with VoiceOver, and records what they hear. The automated checks in
`e2e/code-review-a11y.spec.ts` and `e2e/code-review-navigation.spec.ts` measure contrast, Tab reach, focus
rings and Escape. They do not replace this review. The
[acceptance matrix](../2026-10-22-cr8-acceptance-matrix.md) lists this gate as open until it is filled in.

It covers what CR-3 built: the inbox, the PR and Changes tabs, the header actions, the split and the dividers.
The overview (#323), the diff and file tree (#324), and the review instructions popover (#325) get sections
here when they land. Their rows are listed at the end so they aren't forgotten.

**Build:** `main` at `0e674e7` or later, built with `pnpm build`. Record the SHA you used.

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
   Repeat A1–A6 at about 900×600 and note anything that differs.

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

## Not yet testable (add when the slice lands)

| Slice | Rows to add |
| --- | --- |
| #323 overview | The title as a heading; description headings and lists; activity cards in order; check rows read state in words, not colour; "No comments" only when complete; the composer never hides focus |
| #324 diff | File headers; the Viewed toggle (if decided); line numbers read old and new; expanding context; selecting a file in the tree moves to its section; filter files |
| #325 review | R3's instructions popover: its scope line, Escape returns focus to the gear; review start, stop and progress announced |
| #326 writes | Confirmation dialogs; submit announced once; reconciliation state after an uncertain write |

## Result

| Reviewer | Date | SHA | macOS / VoiceOver | Outcome |
| --- | --- | --- | --- | --- |
| | | | | |
