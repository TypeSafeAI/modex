# CF-7 failed-command context correction

PR #450 at `2fffd9cbdc02264c986878694cce7de1239740d8` omitted failed commands from its possible-writer list. A real shell reproduction, `printf changed > partial.txt; exit 1`, returned 1 after writing `changed`; the proposed context map returned no files and no possible-writer commands. A nonzero exit does not roll back earlier writes.

The correction collects possible-writer commands after excluding denied outcomes but before excluding failed outcomes from named file relations. It names the command without inferring a file path. Existing classification, command order and deduplication remain unchanged. The saved Note and footer retain the uncertainty.

The new unit regression first failed because the command list was absent; after the correction all 39 task-context tests passed. The footer E2E case now also supplies a failed command receipt and verifies its displayed command with no guessed file. Independent read-only review found no blocking issues; broader shell-classifier completeness and native backend acceptance were not established by that review.

Validation on the correction atop integration base `97895496b7b130158a7ddd7fb56c7f9821b8cb5e`: full build passed; full unit validation passed with 2,252 passes, 26 skips and zero failures; full E2E passed with 476 desktop passes and 7 skips in 26.1 minutes, plus 7 site passes in 17.6 seconds. Transcript median was 201.4 ms on Apple M5 Max, 18 cores, Node 24.22.0. The baseline includes PR #450 plus already-landed main changes through #446. These are local test and shell observations, not additional native-provider or human acceptance for #280. Protected delivery is pending.

Logs, the first failure, the shell reproduction, review result and candidate patch are preserved under `/Users/buns/Documents/Codex/artifacts/modex-land-and-prune/` with the `cf7-failed-writes` prefix; the reproduction is under `pr450-review/`. The parent branch and worktree remain owned by their original session.
