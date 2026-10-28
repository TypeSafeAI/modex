# Notes history sibling identity repair

PR #423's hosted run `40678296881` failed the legacy Notes migration journey because the expected revision summary matched two elements. That run also had unrelated Settings and Markdown sizing failures before reaching its 45-minute execution limit. Its log and traces remain preserved under `~/Documents/Codex/artifacts/modex-land-and-prune/lm3-ci-first-*`; this repair does not claim to resolve those other failures.

On main `b64361750983068160fe95293192ccea03000f88`, `PageHistory` and `BlockEditor` were siblings with the same `page.id` key. They now use distinct `history:` and `editor:` prefixes. Each identity remains stable within a page and changes when the selected page changes.

The existing migration test now repeats history open/close cycles, requires exactly one history region and revision row, verifies complete removal on close, and checks that the selected page's title and content survive. Its original migration, disk layout and restart assertions remain intact. Before the production change, all three repetitions failed: one accumulated eleven summary rows and two left a history region after closing it. After the key change and rebuild, all three passed in 18.3 seconds. No timeout or assertion was weakened.

Both builds passed. Independent read-only review found no blocking findings and no neighboring sibling identity collision. Full unit checks passed with 2,191 passed, 23 skipped and zero failed. Full root E2E exited zero: 470 desktop tests passed, seven skipped (24.8 minutes), then all seven site tests passed (11.4 seconds). The repaired history regression passed in the full run. Hosted verification and protected delivery remain pending. This is local regression evidence, not release or human acceptance.

Evidence outside the worktree: `notes-history-red-e2e.log`, `notes-history-red-traces/`, `notes-history-green-e2e.log`, `notes-history-red-build.log`, `notes-history-green-build.log`, `notes-history-unit.log` and `notes-history-full-e2e.log`, under `~/Documents/Codex/artifacts/modex-land-and-prune/`.
