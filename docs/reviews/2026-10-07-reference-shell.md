# Reference desktop shell

Graphite matches the neutral surfaces and shell proportions of the October 7 reference screenshot while keeping Modex's existing actions connected to real application state.

The reference is 4354 × 2100 physical pixels. The Electron capture uses 2177 × 1050 logical pixels. Its dominant sampled colors are `#0f0f11` (canvas), `#131315` (sidebar), `#1b1b1c` (window), `#262729` (composer), and `#202022` (raised card). Graphite uses these exact values.

The title bar is 44 px high, the rail is 52 px wide, and the sidebar is 344 px wide on large windows. The title begins beside a folder icon at the sidebar boundary. Actions stay 10 px from the window edge with the workspace open or closed. At narrow widths, the existing responsive sidebar reduction remains active.

Thread rows rest at 30 px. Focusing a row reveals its provider, model, branch, and PR metadata. The repository overview appears only when the main pane is at least 1400 px wide, so it cannot overlap the centered 736 px conversation column. Its Changes button opens the workspace; Open folder uses the thread's actual checkout. There are no decorative search/source controls implying unsupported features.

Graphite is the default for new profiles and settings with no recognized theme. Explicit Jev and OpenCoven preferences survive migration. Existing profiles can select Graphite in Settings → General → Theme. The renderer and native background share the same theme definition.

## Verification

- Full monorepo build and typecheck passed.
- All 328 unit tests passed after synchronizing with `origin/main` at `d9c6896`.
- All 22 targeted Electron tests passed, including reference geometry, fixed title-bar actions, renaming, repository overview navigation, narrow windows, pane combinations, theme persistence, and terminal continuity.
- The complete desktop suite passed all 123 tests; all seven website end-to-end tests passed.
- The ad-hoc signed Apple Silicon preview passed strict bundle signature verification and both packaged reference-shell/theme tests.
- Electron screenshot visually reviewed. Native macOS traffic lights are outside Playwright's page capture. Human VoiceOver acceptance was not performed.

This is a functional visual match, not a claim of identical screenshot bytes: thread content, project names, model labels, native window chrome, and available Modex features differ from the reference. The separate `Modex Graphite Preview.app` is an ad-hoc signed local preview, not a notarized release. It launches with an isolated demo profile; the installed production app is preserved.
