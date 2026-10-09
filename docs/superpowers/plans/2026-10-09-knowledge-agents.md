# Agent knowledge maintenance implementation plan

**Goal:** Claude and Codex threads can search, read and maintain the selected OpenKnowledge folder, with per-project automatic maintenance and visible, recoverable updates.

**Architecture:** Keep inference in the existing CLI backends. A main-owned, loopback MCP adapter exposes only document operations and forwards them to pinned OpenKnowledge 0.83.2. A stable per-thread endpoint has a revocable per-turn lease; every call checks current folder, project permission and turn mode. The companion owns collaborative writes and history.

**Tech stack:** Electron, TypeScript, React, MCP SDK 1.32.1, OpenKnowledge 0.83.2.

## Execution ledger

- [x] Create isolated `knowledge-agents` worktree from origin/main; baseline unit suite.
- [x] Inspect installed 0.83.2 tool schemas and verify HTTP initialization/root confinement in a disposable fixture.
- [x] Add failing adapter tests: scoped document operations, read-only/disabled/revoked access, traversal/symlinks, write receipts and errors.
- [x] Implement `engine/knowledge-agents.ts` and maintenance instructions, backed by MCP SDK and KnowledgeService lifecycle.
- [x] Add per-project `knowledgeMaintenance` persistence and IPC setting, default false.
- [x] Integrate per-turn leases in runner; attach stable endpoint and instructions to Claude and Codex, including resumed threads.
- [x] Add Knowledge view project toggles and clickable persisted transcript receipts; open the selected document in the knowledge editor.
- [x] Verify real companion search/read/create/edit/history, editor visibility, overlapping edits, history restoration and shutdown in disposable tests. Both installed CLI backends also passed live search/write/read with zero approvals.
- [x] Run build, unit, typechecks and full Electron/site E2E. Review requirements, security boundaries and current diff. Update docs/status.md and record verification in `docs/reviews/2026-10-09-knowledge-agents.md`.

## Acceptance evidence

Tests must prove the knowledge folder is independent of thread/worktree cwd; changing folders or disabling maintenance invalidates active writes; chat/plan never mutate; errors do not claim successful saves. SDK clients exercise the actual HTTP adapter. Backend tests inspect the real launch/RPC boundary. Real-companion tests prove persistence and history through 0.83.2. E2E covers settings persistence and opening an update receipt. No direct file write path is used for agent updates, no new inference API is introduced, and unrelated worktrees are preserved.
