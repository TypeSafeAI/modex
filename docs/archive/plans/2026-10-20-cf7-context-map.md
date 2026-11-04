# CF-7 context map implementation plan

**Status (2026-10-30): delivered.** The files list landed in #355 (`3e416ab`) and shipped in v0.4.0; the close-out follow-ups #450 and #453 name commands that may have changed unlisted files. The boxes below were not ticked during execution and are historical. Behaviour: [task-context.md](../../task-context.md#context-map).

> **For agentic workers:** this plan is executed inline in the #273 tracker session (TDD, red first).
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a turn's record lists the project files it actually touched, by what the CLI reported:
changed, read, or searched and listed. The list is bounded for display and says what it does not
cover. This is CF-7 #280's open item "An on-demand context map", from its implementation step
"build context on demand from … files actually inspected during the native turn. Default display is
at most 20 file/test references with an explicit overflow count … No automatic whole-repository
graph build."

**Native capability:**
- **codex-cli 0.163.0:** `commandExecution.commandActions` is Codex's own parse of a command:
  - `read {command, name, path}`;
  - `listFiles {command, path}`;
  - `search {command, path, query}`;
  - `unknown {command}`.

  Modex drops it today, and now keeps it on the command's `exec`.
- **Claude Code:** the tools name their files: `Read` (`file_path`), `Grep` (`path`, `pattern`) and
  `Glob` (`path`, `pattern`). A Bash command reports no parse, so a `cat` through Bash is not counted
  as a read.
- **The offline engine:** `read_file` (`path`) and `list_dir` (`path`).

**Decisions:**
- **Relations:**
  - `changed` comes from patch tools that were not denied;
  - `read` from the read actions and tools above;
  - `searched` from search and list.

  A file can have several relations. Every relation is "observed", meaning the CLI reported it. No
  model-proposed or inferred relation is made: Modex does not guess dependencies.
- **Paths** are relative to the thread's working directory. Paths outside it are counted, never named.
- **Display:** at most 20 entries, ordered changed, then read, then searched, with "and N more". The
  record keeps them all. The footer has a **Context** toggle, shown only when there is something to
  show. The note gets a "## Files the turn touched" section.

## Tasks

- [ ] **Red:** in `test/task-context.test.ts`, the relations from Claude, Codex (`exec.actions`) and
  mock items; denied edits excluded; outside paths counted; the 20 cap with overflow; and the
  Markdown section. Run them and watch them fail.
- [ ] **Red:** in `test/codex-backend.test.ts`, `commandActions` on `item/started` carried into
  `exec.actions`.
- [ ] **Green:** `Exec.actions` in `shared/evidence.ts`; the Codex mapping; `taskContext()` in
  `shared/task-context.ts`; and `taskMarkdown`'s section.
- [ ] **Red, then green:** the footer **Context** toggle in `e2e/task-to-notes.spec.ts`.
- [ ] Update `docs/task-context.md` (Not done yet), `docs/conversation-evidence.md` (Codex command
  actions) and `docs/status.md`.
- [ ] Run build, typecheck, the unit suite and the e2e suite. Make signed commits and open a PR.
