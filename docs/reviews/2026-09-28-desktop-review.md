# Desktop architecture, interaction, and performance review

This review fixes reproduced failures in turn lifecycle, transcript durability, Git changes, and desktop interaction. It preserves the CLI execution boundary and the measured chat layout.

Run the same checks locally:

```sh
npm run build
npm test
npm run typecheck
npm run test:e2e
```

## Contracts reviewed

| Area | Source and decision |
| --- | --- |
| Plans and scope | `README.md`, `CONTRIBUTING.md`, `docs/auto-routing.md`, discovery guidance, and `apps/desktop/design/tokens.md`. Keep Claude and Codex as the execution backends, the mock engine for offline verification, and the existing UI geometry. |
| Proposed terminal work | The separate T1/T2 stack, PRs #25 and #26, divides engine/lifecycle from panel interaction. This change starts from `b7f2f71` and leaves those branches with their existing owners. Its runner and main-process lifecycle changes must be retained when integrating that stack. |
| Execution and policy | Main-process IPC, the runner, Claude/Codex/mock adapters, core agent/tools, approvals, sandbox policy, routing, secrets, and login-shell environment. Coding turns remain in the CLIs; Jev only supplies routing evidence. |
| State and lifecycle | Store snapshots, transcript load/event ordering, concurrent turns, cancellation, thread/project removal, and macOS window close/reopen. |
| UI and UX | Thread navigation, draft/send flow, Changes selection/loading/error states, Settings focus, IME input, transcript scrolling, measured design tokens, and reduced-motion behavior. |
| Performance | Cold status reads, streamed tool persistence, completed Markdown rendering, and changed-file lookup/counting. Use operation counts for repeatable comparisons rather than machine-dependent timing thresholds. |

## Findings and changes

| Finding | Change | Regression evidence |
| --- | --- | --- |
| Codex can start a coding turn after Stop during initialization. | Cancel setup locally without killing the server shared by other threads. | Delayed initialization with cancellation; no `turn/start`. |
| A Codex server crash leaves a turn running forever. | Settle subscribed turns on disconnect and clear server state. | Crash after `turn/start` has replied, followed by a new server and resumed thread. |
| Late output/completion from an earlier turn affects the current one. | Match notifications to the current turn; buffer events until its start reply identifies it. | Stale output and completion on the same thread. |
| Cancellation returns before execution has stopped. | Claude waits for process close and escalates SIGTERM to SIGKILL after 1.5 seconds. Codex sends one interrupt and waits for terminal acknowledgement; after 1.5 seconds it reports that confirmation is still pending. | Delayed Claude close and Codex acknowledgement. |
| Deletion removes a live worktree or recreates deleted transcripts. | The runner owns removal, waits for active turns, rejects new work during removal, and ignores late sink callbacks. Project removal also waits for pending worktree creation. | Deferred turn, late output, project admission, and pending creation tests. |
| A failed backend leaves usable approval buttons in an inactive turn. | Persist pending approvals as denied during finalization. | Backend failure with an outstanding approval. |
| Backend reasoning/tool IDs repeat across turns. | Scope backend IDs to the current runner turn. | Two turns using the same backend IDs retain separate output. |
| UTF-8 split across stdout chunks becomes replacement characters. | Decode stream bytes with `StringDecoder`. | Every byte boundary in Japanese, emoji, and accented text. |
| Tool deltas synchronously rewrite the whole transcript. | Coalesce partial writes at 250 ms; flush item/turn boundaries and finalize incomplete items. | Write-count test plus reloaded final output after failure. |
| Startup reads every transcript just to obtain idle status. | Read status from live slots and clone app state once. | Twenty idle status queries require zero transcript reads. |
| Discarding a staged rename removes both working files. | Read full NUL-delimited status and restore both paths. Protect recreated sources, including dangling symlinks; handle case-only renames in order on case-insensitive volumes. | Rename plus destination edits, recreated source, symlink, and case-only rename fixtures. |
| Numstat paths do not match Unicode, tab, newline, or rename paths. | Parse NUL-delimited numstat and match paths through a map. | Real Git repositories with all four filename cases. |
| Background completions or stale requests overwrite selected Changes. | Tag snapshots with thread identity and accept only the newest selected-thread request. | Background completion and deliberately reversed refresh responses. |
| Selecting a file temporarily labels the old diff as the new file. | Tag diff results with thread, path, and snapshot; show loading or failure explicitly. | Delayed diff response after file selection. |
| Transcript loading overwrites newer live events. | Journal events during loading and replay them over the snapshot without duplicate IDs. | Item and item-update events arriving before a delayed snapshot; runner snapshots include unflushed live output. |
| Changes file selection requires a mouse. | Use a named native button with pressed state; reveal discard on keyboard focus. | Keyboard selection changes the displayed diff. |
| IME confirmation sends a message. | Ignore composing Enter and key code 229. | Composing Enter preserves Japanese text and creates no user item. |
| Settings lets focus and app shortcuts escape behind the dialog. | Focus the first control, wrap Tab, close on Escape, restore trigger focus, and suppress app shortcuts. | Electron keyboard/focus assertions. |
| Every streamed delta reparses completed Markdown. | Memoize Markdown by text. | Count parsing of 100 completed replies during ten live updates. |
| Sending while scrolled up sometimes leaves the next turn offscreen. | Detect a new user ID even when React batches it with reasoning events. | Existing reader-scroll and next-send acceptance test. |
| Closing the macOS window during streaming leaves the turn running. | Clear the closed window reference and guard event delivery to destroyed web contents. | Close during streaming, finish without a window, reopen with the complete transcript. |

## Repeatable performance measurements

| Fixture | Before | After |
| --- | ---: | ---: |
| Completed Markdown parses, 100 replies and ten updates | 1,000 | 0 |
| Whole-transcript writes, 1,000 tool-output deltas ending in failure | 1,003 | 4 |
| Transcript reads for 20 idle status queries | 20 | 0 |

The persistence cadence bounds intermediate writes while preserving the final transcript on normal completion, interruption, or backend failure. An abrupt application or machine crash can still lose the latest unsaved interval. The tests measure operation counts; they do not claim a production latency percentile.

## Verification results

On macOS, `npm run build`, `npm test` (15 core and 79 desktop tests), `npm run typecheck`, and `npm run test:e2e` (38 tests) passed. Rendered approval and completed-thread captures were inspected at 1786 × 1049. The existing layout assertions also check composer visibility in a 1380 × 880 window.

## Verification boundaries

The unit suite drives real temporary Git repositories and scripted CLI processes. Electron tests exercise the installed runtime with the offline mock engine, including window lifecycle, keyboard interactions, layout, scrolling, and persistence. These checks do not represent live paid-provider execution or human VoiceOver acceptance.

The review does not add dependency upgrades, an API execution mode, transcript virtualization, a design-system replacement, or the separate terminal feature. Those changes need their own evidence and scope. Existing routing/secret separation and core sandbox-policy coverage remain in place.
