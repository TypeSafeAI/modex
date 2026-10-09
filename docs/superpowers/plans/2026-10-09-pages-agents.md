# Pages agent maintenance implementation plan

> **For agentic workers:** Use subagent-driven-development or executing-plans. Track evidence below.

**Goal:** Agents manage Modex Space notes end to end through our own Pages MCP server.

**Architecture:** A main-process loopback `modex_pages` MCP server operates on the existing SpaceStore, independent of OpenKnowledge. Stable per-thread endpoints have authority only during an active turn. A per-project opt-in gates all notes access; chat/plan turns are read-only. Revisions prevent stale writes and an atomic version journal supports recovery. Existing CLI adapters receive session-local MCP configuration. Space refreshes agent changes while preserving unsaved human drafts; thread receipts open the page.

**Tech Stack:** TypeScript, MCP SDK 1.32.1, Electron, React, Node tests, Playwright.

- [x] Storage: add atomic revision history with actor/summary, revision-checked trash and historical content restoration; preserve old version-1 stores. Tests cover stale writes, tree trash/recovery, attribution, restart and corruption.
- [x] Pages MCP: expose search/read/create/edit/update/trash/restore/history/revert; validate strict arguments, enforce project opt-in and immutable turn read-only ceiling, stable routes and shutdown. Test via actual SDK HTTP client against disposable SpaceStore.
- [x] CLI/runner: connect both Claude and Codex to Pages alongside Knowledge, exact tool allowlists, turn guidance, persisted page receipts, stop/failure revocation. Extend adapter and runner tests.
- [x] UI/main: per-project agent notes access, refresh clean pages on remote change while preserving pending drafts, clickable thread receipts, user version recovery. E2E through real Electron and MCP requests exercises creation/edit/search/organization/trash/restore/history, restart, permissions and concurrent edits.
- [x] Acceptance: live installed Claude/Codex tools against disposable notes store. Full build/unit/typecheck/desktop E2E; site E2E if affected by shared workspace. Independent spec and code review. Update docs/status and usage/evidence docs. Signed commit only after checks.

## Contract

`PagesAgents({ space, enabled, updated })` exposes `prepare(thread, changed, signal?) -> {connection:{url,instructions},close()}` and `dispose()`. `PagesChange = {pageId,title,summary,revision}`; project `pagesMaintenance?:boolean`. Server name `modex_pages`. Tool arguments use page IDs and expected revisions, never filesystem paths. `SpaceStore.history(id)` returns version snapshots with actor/summary; `revert(id,revision,version,change?)` creates a new revision. Store create/save/trash accept optional `{actor,summary}`; trash accepts optional expected revision. Existing renderer actions are attributed to `human` by default.

## Evidence

Implementation and focused verification complete. Installed Claude and Codex acceptance passed including resumed sessions. Independent spec/quality review findings repaired. Final build/typecheck passed; 455 unit, 159 desktop E2E and 7 site E2E tests passed. See docs/reviews/2026-10-09-pages-agents.md. Changes remain local and unreleased.
