# Minimal right workspace

You can review a diff at the default 360 px rail width without squeezing it beside a file tree. The file list sizes to its content above the diff, capped at 30% of the available content height. Above 520 px, files move beside the diff. Selection, filters, display options, and scroll positions survive switching tools and hiding the rail within the current thread.

The direction follows Modex's [Graphite reference](2026-10-07-reference-shell.md) and the file selection, wrapping, and unchanged-line controls in [OpenAI's review documentation](https://developers.openai.com/codex/app/review). It retains the existing theme tokens, typefaces, native browser isolation, and persisted pointer/keyboard resizing. This is a focused adaptation to Modex's narrow rail, not a pixel-identical recreation of the Codex app.

The review applies Frontend Design for visual restraint, Better UI for surfaces and hit targets, and Emil Design Engineering for immediate keyboard interactions and stable geometry.

## Review findings addressed

Paths below are relative to `apps/desktop/src/renderer`.

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |
| HIGH | `workspace.css`, `.review-body` | The default rail divided its width between code and files. | Content-sized, independently scrolling files above full-width code; side-by-side layout on expansion. | Content gets readable space at every supported width. |
| MEDIUM | `components/Workspace.tsx`, review rendering | Changing tools or hiding the workspace unmounted Review. | Keep Review mounted while its tab exists; hide inactive content and close its menu. | Preserve the place you were reviewing. |
| MEDIUM | `components/ChangesPanel.tsx`, toolbar | Seven icons, a one-choice branch menu, and a second branch row. | One branch summary, explicit file count, four controls; secondary options in a keyboard-accessible menu. | Progressive disclosure reduces competing controls and recovers 52 px of vertical space. |
| MEDIUM | `components/Workspace.tsx`, tabs and launcher | An unused blank tab, unsolicited Gmail suggestion, and changing tabbar height. | Start with Review only, keep a tool-focused launcher, and use one 40 px tabbar. | Stable geometry and intentional content reduce visual noise. |
| MEDIUM | `components/Workspace.tsx`, tab closure | Closing an active or inactive tab could lose keyboard focus. | Focus the surviving active tab, selecting a neighbor only when the active tab closes, and label the panel from that tab. | Keyboard navigation remains continuous. |
| MEDIUM | `components/ChangesPanel.tsx`, large totals | Five-digit addition/deletion totals overflowed the 280 px toolbar by 14 px. | Compact totals retain exact values in tooltips. | All four controls remain inside the narrow rail. |
| LOW | `workspace.css`, actions and file headings | Narrow-only 23 px controls, hidden discard actions, and a 100 px filename cap. | 28 px review controls, focus/touch-visible discard, and filenames using available width. | Quiet controls remain reachable and filenames remain recognizable. |

No new animation is introduced for frequent tab changes, filtering, or resizing. Layout changes are immediate, including under reduced motion.

## Verification

The integration replays only the ten rail files onto main at `8e13d4a4` after #163, retaining Canvas, Browser Tools, Streamer Mode, and modal suspension. The full gate tested tree `9c552199` on the approved prospective #163 tree `cdfb4027`. Actual main differs from that upstream tree only in three documentation files. Reconciliation preserves those updates; every production and test blob is identical to the passing gate. The original and verified rail snapshots are archived outside the worktree.

- Initial integrated install, build and typecheck passed on Node 24.18.1. Unit tests passed: 834 passed, 12 Windows-only skips, zero failures, with real OpenKnowledge enabled.
- The first focused invocation found a test syntax error before executing any UI checks. Removing one extra parenthesis preserved the native-bounds assertion.
- The large-totals regression then demonstrated 14 px of toolbar overflow at 280 px. Compact number display fixed it; exact totals remain in tooltips.
- Inactive close controls are intentionally revealed by hover or focus-within. The test now focuses the inactive tab, presses Tab to its Close button, and confirms Review remains selected before closing. It then demonstrated that Review lost focus. Restoring the surviving active tab's focus fixed that regression without changing selection.
- The corrected source passes all four focused Electron tests with no skips: Review filter/selection/options/scroll retention, narrow and expanded layout, active/inactive close focus, 63 changed files with large two-sided totals, and Browser/Canvas toolbar containment and native bounds at 360 px, 280 px, and expanded widths.
- Build and typecheck passed after the production fixes. The final gate passed 834 unit tests (12 Windows-only skips), all 245 desktop E2E tests with real OpenKnowledge, and all seven site tests. E2E had no failures or skips. The gate verified all 538 frozen source hashes and cleanup of owned and detached worktree processes.
- Screenshots at 280 px, 360 px and expanded widths were visually reviewed after the fixes. Automated focus setup and assertions are not human keyboard-only acceptance. Human VoiceOver, physical touch and signed packaged-app acceptance remain unverified.

The earlier isolated baseline on `5e80b46` passed 621 unit tests and 199 desktop plus seven site tests, with one unit skip and three optional Knowledge skips. Those results are historical and do not establish integrated acceptance.

The existing app, layout and persistence tests now assert hidden visibility instead of DOM removal because Review remains mounted. No added regression assertion was weakened to obtain a pass.

Disposition: integrated gates and source-only reconciliation onto actual main passed. Retain the worktree until final review and protected merge are complete. No release tag or packaged acceptance is claimed.
