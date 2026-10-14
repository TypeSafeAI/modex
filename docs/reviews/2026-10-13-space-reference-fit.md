# Space layout verification

Delivery branch: `knowledge-fit`. These changes are unreleased.

Knowledge guest bounds now convert renderer CSS pixels to native view coordinates using
shell zoom. Pages keeps the comments rail beside the document, places compact comment
entry at its top, and keeps the page chat launcher reachable. Menus, templates, lists,
checkboxes and typography follow the supplied references in Graphite while retaining
other themes. Selected rendered text exposes formatting, comments and edit requests.
Generate/Visualize cards collect an instruction before staging it in the existing CLI chat.

The continuation adds a directly editable bottom composer, per-page request/generation
drafts with restart protection, safe link insertion, block-type conversion and keyboard
focus restoration. Generate now has a dedicated toolbar action; favorites live in page
actions. The overview supports search, favorites, list/grid views and aligned columns.
Completed transcript tool/reasoning/progress rows fold under the duration header. Final
answers, failed tools, notices and pending approvals stay visible. Expanding work retains
item state and chronological ordering.

The insert menu clamps to the viewport at narrow window sizes. The selection toolbar
only appears for a text selection, keeping the page title reachable during ordinary typing.
Repeated CSS declarations were removed without changing the final cascade.

Initial verification (before the second polish pass):

- Full monorepo build and desktop typecheck passed. The final renderer was rebuilt after
  the last spacing adjustment.
- `npm test`: 1,404 passed, 16 skipped, no failures.
- All 285 desktop E2E cases have passing evidence across the broad run and focused reruns.
  The initial run was **269 passed, 12 failed, 4 not run**; it was not a clean single run.
  It included all three real Open Knowledge companion flows.
- The 60-case rerun passed 56, resolving approval/attachment flow expectations, Chromium
  setup, transcript geometry and Knowledge toolbar height. Four selection/overlap failures
  remained and were fixed in the renderer.
- All 30 Pages, selection and Streamer Mode cases then passed. This covers stable rendered
  selection, bold/italic composition, URL validation, request drafts, block conversion,
  keyboard focus, narrow menus and title access with a wrapped toolbar.
- All 18 browser-document cases passed in isolation, including the two initial Electron
  cleanup timeouts. All seven site E2E cases passed after installing missing Chromium.
- After the final CSS adjustment, all 12 reference-shell/Space-fit cases passed.
- Fresh Graphite captures were reviewed at 1000 × 1200, plus the narrow 900 × 700 layout.
  They include overview, page, insert/page menus, generation/visualization prompts,
  selection toolbar, comments, and expanded page chat.

Evidence is copied outside the worktree to
`/Users/buns/.codex/artifacts/modex-knowledge-fit/`, including run logs, initial failure
traces, screenshots, geometry measurements and the comparison viewer.

Review caught and fixed discarded overview requests, bold/italic delimiter confusion,
focus loss after block conversion, selection loss from remounted checklist renderers,
wrapped toolbar overlap with the title, unsafe substring mapping for escaped/code Markdown and a stale
anchor that hid generation drafts. Rendered formatting is deliberately disabled for
ambiguous or syntax-bearing selections; source editing and comments/edit requests remain
available. Task-list prefixes remain supported.

`/Users/buns/.codex/artifacts/modex-knowledge-fit/space-fit/compare.html` places current captures alongside the
supplied right-hand targets and provides an opacity slider for overlay inspection. It
keeps the original reference images intact and crops their left-hand Modex comparisons
only in the display. Target windows differ slightly in size and scroll position.

These are screenshot-guided layouts, not a certified pixel-identical clone. The target
includes capabilities Modex does not expose (for example voice controls and shared pages);
no decorative controls were added for unsupported actions. Generation stages a request;
it does not claim content has been generated before a coding agent runs. Human VoiceOver
acceptance and a numerical image-diff comparison were not performed.

Second polish pass:

- Synced with `origin/main` at `e3fecf0` before verification and delivery.
- Insertion and generation follow the last active block; rendered selections support
  Cmd/Ctrl+B, Cmd/Ctrl+I, Cmd/Ctrl+K and Escape with focus restored to the document.
- Added functional page sorting, guide/feedback templates, context-specific icons,
  Markdown syntax hints and closer template/menu styling.
- Contextual comments cap quotes at 2,000 characters, refresh quotes in empty drafts,
  preserve drafts containing text and support Cmd/Ctrl+Enter to post.
- All 26 focused Pages tests passed. Independent review found no remaining important
  issues in these changes.

Final pre-push verification:

- Full monorepo build, desktop typecheck and `npm test` passed: 1,410 tests passed,
  16 platform skips, no failures.
- The full desktop run completed with 280 passed, eight failed and one not run. Four
  failures came from a missing shared Chromium executable; four Electron startup/load
  failures coincided with a severe host load spike. No product changes were needed.
- All 12 cases in the affected browser, usage, Pages-agent and panel-layout suites passed
  in isolation using a task-owned Chromium installation. All 289 unique desktop cases
  now have passing evidence; this is not a claim of one clean full-suite run.
- All seven site E2E cases passed. Real Open Knowledge companion flows passed in the
  full run. Fresh second-pass Graphite screenshots and the comparison viewer were reviewed.
- `git diff --check` and the worktree ownership check passed. Main remained at `e3fecf0`
  when verification completed. CI will independently gate the protected PR merge.

The second-pass logs, failure traces and `second-pass-case-coverage.json` are retained in
`/Users/buns/.codex/artifacts/modex-knowledge-fit/`.
