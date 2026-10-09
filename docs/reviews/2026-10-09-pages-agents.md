# Pages MCP agent maintenance verification

Scope: locally implemented on `knowledge-agents`, following knowledge integration commit
`4209c69`. Not merged or released. No existing user notes were used for acceptance.

## Requirements and evidence

| Requirement | Evidence |
| --- | --- |
| Modex-owned Pages server on the actual notes store | `pages-agents.ts` implements loopback Streamable HTTP MCP backed by `SpaceStore`; SDK client tests exercise search/read/create/edit/update/trash/restore/history/revert against disposable on-disk stores. No companion or remote Pages dependency. |
| Claude and Codex use tools end to end | `2026-10-09-pages-cli-acceptance.json`: actual Claude 2.1.289 and Codex 0.162.0 each search/create/read/edit, then resume the same session and endpoint for a second edit. Disk revision 3 and attributed history verified, zero approval prompts, coding directories untouched. |
| Per-project opt-in and read-only access | Store persistence tests; Pages HTTP tests cover disabled project, chat, plan, live reductions, expired routes and browser-origin rejection. Runner tests defer setup and Auto routing while changing mode to verify the original permission ceiling. |
| Requests cannot cross turn authority | Partial-body POST regressions for both Pages and Knowledge wait for the specific tagged request before closing its lease and starting a writable turn. Both fail against temporary compiled copies of the old handler and pass with request-arrival authority capture. |
| Concurrent edits preserve human writing | Expected revisions reject stale edit/update/trash/restore/revert. Two overlapping MCP writers yield exactly one success. Empty-note edits work; missing, repeated and overlapping matches fail. |
| Visible, durable receipts and native UI | Electron CLI fixture exercises real main/runner/backend/MCP/store wiring, organization, trash/restore and history. Receipt opens native note and survives app restart. A separate live-CLI test supplies actual provider proof. |
| UI refresh and recovery | Electron tests cover external note refresh, historical version restoration, newly added project controls, and conflicting draft recovery with editing locked during asynchronous copy creation. Existing Space E2E covers editing, export/import, trash, persistence, failure/retry and narrow layout. |
| Durable journal without per-keystroke growth | Version-2 atomic journal retains a legacy baseline and every explicit mutation. Human typing coalesces into 30-second checkpoints. Tests cover restart, corruption, stale revisions, tree recovery, checkpoint boundaries and pre-agent content recovery. Reviewer probe: 100 KB note plus 501 typing edits stores ~302 KB / 2 versions versus ~50.6 MB / 502 before coalescing. |
| Lifecycle and existing Knowledge integration | Stop/failure/finally close leases; loaded Codex routes remain stable. Exact tool allowlists for both servers. Existing real OpenKnowledge tests included in broad verification. |

## Verification ledger

- Focused implementation tests passed, including regression failures before their fixes.
- Final `npm run build`: passed across all workspaces.
- Final `MODEX_TEST_OPEN_KNOWLEDGE=1 npm test`: **455 passed**, zero failed/skipped (core 15, desktop 420, browser-dev 1, site 10, Store desktop 9).
- Final `npm run typecheck`: passed across all workspaces.
- Final `MODEX_TEST_OPEN_KNOWLEDGE=1 npm run test:e2e`: **159 desktop + 7 site passed**, root command exit 0. Real OpenKnowledge integration tests enabled.
- `git diff --check`: passed.
- Independent spec review: no remaining blockers after draft locking, empty-page editing and project refresh fixes.
- Independent quality review: delayed request, Auto routing ceiling, checkpoint growth and overlapping-match findings addressed and reviewed.
- Native Space screenshot inspected at `apps/desktop/.probes/space/space-overview.png`.

Logs are local `/tmp/modex-pages-verified-{build,unit,types,e2e}.log` for the final run.
The live CLI receipt is committed alongside this record. Disposable homes and coding
repositories isolate test writes; no global CLI configuration was changed. Human
VoiceOver acceptance was not performed.

## Storage compatibility

On mutation, version-1 Space storage upgrades to version 2 with existing pages preserved
as baseline versions. Older builds reject version 2 rather than silently dropping history.
Human typing checkpoints can skip revision numbers; every explicit agent operation has
its own snapshot. See [usage and recovery](../pages-maintenance.md).

## Integration with main

Integrated `cc3791b` (thread approvals and task retirement) before landing. Initialization
retains both MCP agents and TaskRetirer; shutdown stops retirement before draining MCP
leases. Independent integration review found no blockers. Fresh workspace build and
typechecks passed, with 466 unit tests, 161 desktop E2E and 7 site E2E tests, including
real OpenKnowledge. Logs: `/tmp/modex-landing-{build,unit,types,e2e}.log`.
