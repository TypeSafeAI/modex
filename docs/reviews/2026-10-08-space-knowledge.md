# Space and OpenKnowledge integration

Space adds local Markdown pages below Home and embeds a local OpenKnowledge editor.
The `space-pr` worktree carries the recovered implementation, including the
server-reuse, Home layout, Markdown checklist, and theme integration repairs.

## Run the development build

```sh
cd /Users/buns/Documents/GitHub/TypeSafeAI/modex/.worktrees/space-pr
npm run build
npm run desktop
```

Open **Space** below **Home**. Create a page, or choose **Knowledge base** and select
a local folder. Install the companion once, then open your knowledge base.
OpenKnowledge requires Node.js 24 or newer and Git.

## Source and ownership

- Base: `origin/main` at `a3321f9` (after PRs #137 and #139).
- Owner: Cody. Branch: `space-pr`. Changes remain unreleased.
- The PR snapshot was copied from the resolved, staged integration in `space-verified`;
  that worktree and its unfinished rebase were preserved.
- Recovered 34 uncommitted files from `space-recovery`, whose delivery record links
  back to `knowledge-reuse`. All original worktrees and the primary checkout are intact.
- Product code was inherited. This continuation repairs block boundaries in `joinMarkdown`
  and indentation after imported H1 headings, adds unit and Electron relaunch regressions,
  and synchronizes the embedded editor with the selected Modex theme.
- Native pages use `@create-markdown/core` and `@create-markdown/react` 2.0.3.
  OpenKnowledge 0.83.2 is installed as a separate local companion.

## Behavior

- Native pages support nested pages, favorites, templates, Markdown blocks, checklists,
  search, autosave, import/export, and recoverable trash.
- Page writes preserve raw Markdown, reject stale revisions, and retain failed edits
  for retry. Switching Home and Space preserves unsent chat text.
- Knowledge base embeds the local editor in an isolated native guest without the
  Modex preload or Node access. **Copy to knowledge base** exports a native page
  without overwriting an existing file.
- The guest uses the selected Modex palette for its canvas, editor, text, controls,
  and sidebar. Theme changes refresh its presentation without touching local files
  or companion configuration. During navigation the guest remains hidden until its
  palette is ready, exposing the matching Modex canvas instead of a white page.
- An existing project server is verified through project-scoped `status --json`,
  matching server/UI PID and port, and `/readyz`. **Connected locally / Disconnect**
  leaves that server running, including when Modex quits.
- A server started by Modex uses **Running locally / Stop** and shuts down with Modex.
  The companion environment removes `FORCE_COLOR` to avoid the `NO_COLOR` conflict.
- Imported lists that begin indented retain later dedented items. Visible checkboxes
  stay aligned with their source markers, so checking a later task cannot alter an earlier one.
- Home panes remain direct children of the sheet. Switching to Space hides them
  without unmounting their state, preserving panel geometry and workspace full view.

- Adding or moving a block after imported text ending in one newline now keeps a blank
  block boundary on save and relaunch, while unchanged imports retain exact whitespace.
- Extracting an imported H1 title removes only separating blank lines, preserving
  indentation in code and lists, tabs, and CRLF line endings.
- At narrower widths, OpenKnowledge collapses its file tree. Its **Show Files** control
  opens that tree; the integration tests exercise this default Graphite layout.

## Verification

Fresh checks below passed on the reviewed source based on main `a3321f9`. The canonical record,
including source hashes, change provenance, and the review verdict, is:
`/Users/buns/.coven/workspaces/familiars/cody/handoffs/2026-10-08-modex-space-verified.json`.

Evidence directory:
`/Users/buns/Documents/GitHub/TypeSafeAI/modex/.worktrees/space-verified/apps/desktop/.probes/space-verified/`.

| Check | Result | Evidence in that directory |
| --- | --- | --- |
| All workspace builds | Passed | `build-delivery.log` |
| All workspace typechecks | Passed | `typecheck-delivery.log` |
| Full unit suite | 374 passed | `unit-delivery.log` |
| Full Electron E2E, including real OpenKnowledge | 145 passed | `e2e-delivery.log` |
| Site E2E | 7 passed | `e2e-delivery.log` |
| Block-boundary regression | Failed before repair, 5 focused tests passed after; Electron relaunch test also passed | `boundary-before.log`, `boundary-after.log`, `e2e-delivery.log` |
| H1 import indentation | Failed before repair; 6 focused tests pass after, plus real import/relaunch regression | `import-before.log`, `import-after.log`, `e2e-delivery.log` |
| Selected knowledge theme | Graphite, Jev, OpenCoven painted editor background and text; Settings hiding; reload hiding and persistence | `knowledge-theme-final.log`, `e2e-delivery.log` |
| Exact reported server | Reused `127.0.0.1:56729`; healthy after disconnect; project config unchanged | `reported-server.json` |
| Independent source review | One P2 repaired and re-reviewed; no remaining blocking findings | canonical record `review` |
| Whitespace and patch checks | Passed | `git diff --check`; `git apply --check --reverse source.patch` |

The complete source diff, including new files, is `source.patch` in that directory.
Command timestamps and exit codes are in `checks-delivery.json`.

Native Electron captures were inspected for the page editor, block menu, narrow layout,
knowledge setup, and embedded editor. They are saved in the adjacent `.probes/space/`
directory. A renderer screenshot excludes native guest views; `knowledge-reused-editor.png`
captures the embedded editor separately. `knowledge-theme-graphite.png`, `knowledge-theme-jev.png`, and `knowledge-theme-coven.png` show the actual selected-theme guest. No composite screenshot is claimed.

Checks use Node.js 24.18.1 and `TMPDIR=/Users/buns/Documents/mx-space-verify`, outside Git
and short enough for macOS Unix sockets. Real companion tests run with
`MODEX_TEST_OPEN_KNOWLEDGE=1`.

## Fresh PR verification

Validated in `/Users/buns/Documents/GitHub/TypeSafeAI/modex/.worktrees/space-pr`
on base `a3321f9`. Logs are under `apps/desktop/.probes/space-pr/`:

- `npm run build`: passed (`build.log`).
- `npm test`: 374 passed, no failures (`unit.log`).
- `npm run typecheck`: passed (`typecheck.log`).
- Full desktop E2E with `MODEX_TEST_OPEN_KNOWLEDGE=1`: 144 passed,
  one timeout at app close in the shell navigation test (`e2e-final.log`).
  All eight native Space tests and all four knowledge tests passed, including
  real companion installation, editing, privacy, reuse, and shutdown.
- The failed shell test passed on an isolated retry, 1/1 (`shell-retry.log`).
- Full app-spec retry: 14 passed, including the shell test in sequence (`app-retry.log`).
- Site E2E: 7 passed (`site-e2e.log`).

The initial fresh-install attempt downloaded Electron during launch and timed out.
A retry exposed CLI fixture shebangs containing the spaces in Cave's Node path.
The final runs use Node 24.18.0 copied into `/Users/buns/Documents/mx-space-pr/node`
and `TMPDIR=/Users/buns/Documents/mx-space-pr`; no application code or timeout was
changed to work around these setup issues. The full-run shutdown timeout remains
recorded; an isolated retry does not erase it. Hosted CI remains the merge gate.

## Delivery limits

Signed branch delivery feeds the consolidated integration PR; merge and hosted checks are owned by the integration coordinator. No release or installed-app replacement has been performed.
Keep the worktree until the changes are retained through the signed-commit and PR flow.
Human keyboard-only and VoiceOver acceptance have not been performed.
