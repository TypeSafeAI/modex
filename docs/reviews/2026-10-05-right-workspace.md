# Right workspace replacement

The right side now hosts tabs for Review, Files, Terminal, and browser pages. It replaces the
old stacked Changes panel and the bottom terminal. Existing shell sessions, discard confirmation,
thread-local change refreshes, theme selection, and saved workspace visibility retain their behavior.

## Reference states

Val supplied three Desktop screenshots dated 2026-10-05:

| Screenshot | Reproduced surface | Evidence |
| --- | --- | --- |
| `17.38.08` | Rounded New tab menu; New tab and New tab in full view; ⇧⌘B / ⇧⌘F | 241 px menu, two 28 px rows, keyboard dismissal/focus tests |
| `17.38.32` | Review tab; compact toolbar; numbered, wrapped diff on the left; filtered tree on the right | 647 px capture, 42 px tab bar, 255 px file tree, expandable unchanged lines |
| `15.08.49` | New tab; history/address controls; two-column Tools; centered Suggested link | 672 × 926 logical-pixel capture (1344 × 1852 at 2×), 35 px tab bar |

The neutral `#101010` canvas, charcoal chrome, tab treatment, menu, type scale, pills, and spacing
follow those captures. Branch names, comparison base, counts, paths, and file contents come from
the selected project; Review compares its working tree with HEAD. The visual fixture uses long JSONL
records so wrapping and the unchanged-lines fold can be inspected at the reference size.

## Behavior and boundaries

- ⇧⌘B opens a tab; ⇧⌘F opens one in full view. Escape exits full view. Arrow keys navigate tabs.
  ⌘P opens Files, ⌃⇧G opens Review, and ⌃` opens the thread's terminal. Hiding the workspace keeps
  tabs and shells alive; changing threads disposes that thread's browser views.
- Review filters and groups changed files, toggles wrapping/highlights/tree/context, refreshes
  live status, and retains confirmed per-file discard. Git's missing-final-newline markers do
  not advance the old or new line counters.
- Files reads only regular text files inside the selected workspace, with a 1 MB preview limit
  and a 5,000-file listing limit. Traversal, escaping symlinks, and binary previews are rejected.
- Desktop browser guests have their own in-memory session, no app preload, no Node integration,
  and sandbox/context isolation enabled. Navigation accepts HTTPS and loopback development
  servers. Permissions, downloads, and privileged schemes are denied. Guests cannot invoke any
  app IPC channel. They hide beneath menus, Settings, Companion, and Streamer Mode, and are
  destroyed on tab close, renderer navigation, normal window close, and window destruction.
- Browser views belong to the desktop displaying them, including the Store preview client.
  Browser commands never travel over its host connection; disconnected clients hide native
  pages until reconnect. Escape reaches the page outside full view, and Review errors stay
  visible when full view hides the chat.
- The browser's new-tab suggestion is a direct Google Workspace Gmail link; it does not represent
  imported browser history. Remote pages load only after a user navigates. Browser development
  review can use the file/terminal tools; native guest browsing requires the desktop app.

## Verification

`apps/desktop/e2e/workspace.spec.ts` drives the real Electron app against temporary Git repositories
and a local HTTP server. It covers the three captured layouts, menu and tab keyboard handling,
full view, Files, browser navigation/history/isolation, stale navigation, overlay visibility,
guest keyboard forwarding, window destruction, and missing-final-newline diffs.

Existing terminal tests verify actual shell I/O, retained sessions, shell key routing, resizing,
restart, and teardown in the new right-side location. Layout tests cover 960 px and 1366 px
windows and persisted panel combinations. Unit tests cover file boundaries and browser URL rules.

Verified locally on macOS on 2026-10-05:

- `npm run typecheck` and `npm run build` passed.
- `npm test`: 297 passed (15 core, 271 desktop, 1 browser development bridge, 10 site).
- `npm run test:e2e`: 111 desktop and 7 site tests passed after integrating main's Store preview.
- After the final icon/menu alignment, the desktop build and all workspace E2E tests
  passed again. The three captured states were visually inspected against the supplied images;
  the tests assert key dimensions and behavior, not a pixel-exact comparison with the reference.
- Independent review found and verified fixes for aborted navigation replacing a newer page's
  state, missing-final-newline counters, and guest cleanup when a window is destroyed. Landing
  review also covered Store-local browser ownership, offline visibility, native Escape routing,
  full-view errors, and Store renderer-crash cleanup. The new ownership, Escape, and error
  regressions failed against the previous build, then passed with the fixes.
- `git diff --check` passed. The primary checkout remains clean on `main`.

Playwright regenerates `review.png`, `new-tab-menu.png`, and `new-tab.png` under
`apps/desktop/test-results/`. Captures and verification logs were archived outside the disposable
worktree in `~/Documents/Codex/artifacts/modex-right-workspace-2026-10-05/`.
The change is prepared for a signed commit and protected squash merge; it is not a release.
