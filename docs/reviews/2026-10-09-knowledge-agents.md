# Agent knowledge maintenance verification

Implemented on `knowledge-agents`, based on `origin/main` at
`1d1fdfc8c4291653f4fcb6268e1edda38d7ac35c`. This is branch verification, not a release
or an installed-app replacement. [Usage](../knowledge-maintenance.md).

## Behavior

- Claude and Codex receive a scoped local MCP connection for the selected knowledge
  folder, independent of the thread's coding directory.
- Automatic maintenance is opt-in per project. Search, read, write, edit and history
  are the only exposed tools. The adapter enforces the current project permission,
  initial turn restrictions, live read-only changes and folder/server identity.
- Successful writes add persisted page receipts. Links open a validated document URL
  in the local knowledge editor. OpenKnowledge owns collaborative edits and recovery.
- Stop cancels both startup waits and the entire MCP initialization handshake.
  Ended turns cannot operate on documents; in-flight operations retain their receipts.
- Models still use the existing CLI backends. No global agent configuration or
  repository agent files are changed.

## Verification results

| Check | Result |
| --- | --- |
| `npm run build` | All workspaces passed, including Store desktop |
| `MODEX_TEST_OPEN_KNOWLEDGE=1 npm test` | 432 passed: core 15, desktop 397, browser-dev 1, site 10, Store desktop 9 |
| `npm run typecheck` | All workspace typechecks passed |
| Desktop E2E with `MODEX_TEST_OPEN_KNOWLEDGE=1` | 156 passed |
| Site E2E on an isolated local port | 7 passed; identical assertions |
| Final focused adapter checks | 7 passed, including overlapping writes and version restoration through 0.83.2 |
| Installed Claude 2.1.289, Haiku | Search → write → read completed; zero approvals; persisted marker verified |
| Installed Codex 0.162.0, CLI default model | Search → write → read completed; zero approvals; persisted marker verified |
| Independent specification and code reviews | No remaining blockers after repairs and re-review |
| `git diff --check` | Passed |

The [sanitized live-CLI receipt](2026-10-09-knowledge-cli-acceptance.json) records both
actual production-backend turns, page hashes, zero approvals, clean coding directories,
and process disposal. No request interception was used in that final acceptance run.

The combined `npm run test:e2e` completed all desktop tests but its site server could
not bind port 5187: an unrelated River Oaks preview owned it. Site checks then ran
against this branch's built site on port 60975 using an ignored copy of the same
Playwright config/test with only the origin changed. No assertions were changed and
the unrelated process was untouched. Original site spec SHA-256:
`6a983b71a1fe10c78a0c2e045d72b6487d83d75dc62641699afcb47f2d8f22ba`.

## Regression evidence

Tests failed before the corresponding repairs for absent MCP wiring and persistence,
mutable turn authority during setup, cancellation after `initialize`, and a checkbox
that reverted its value while persistence was pending. The final implementation
passes these regressions without relaxing their assertions or timeouts.

The real companion test sends an append from a second writer concurrently with the
agent's targeted edit, verifies both persisted, reads attributed history, then restores
the original version. The Electron test drives a CLI fixture through Modex's production
runner and adapter into the real companion, verifies the separate coding directory is
untouched, opens the receipt, reloads the transcript, and inspects the resulting page
in the native embedded editor. The live CLI tests supplement that fixture coverage.

Local logs are `/tmp/modex-knowledge-final-{build,unit,types,e2e}.log`,
`/tmp/modex-knowledge-site-e2e.log`, and `/tmp/modex-knowledge-concurrency.log`.
The inspected native editor capture is
`apps/desktop/.probes/space/agent-maintained-knowledge.png`. These are local evidence,
not packaged artifacts. Human VoiceOver acceptance was not performed.

The worktree should remain until the branch is retained through the repository's
signed-commit, PR and protected-main landing flow.
