# Attachment acceptance, 2026-10-11

Desktop and browser-development attachments passed storage, draft ownership, CLI delivery, and full native/browser verification. Store attachments remain unavailable, including connected-host mode.

## Verified behavior

Main keeps unique, byte-exact private copies and validates ownership, file identity, metadata, bounded reads, 5 MiB images, 25 MiB other files, and 20 attachments per message. Persisted claims and write-ahead cleanup preserve retries through failure and restart. Removing a thread retires only identity-verified owned files and removes its directory only when empty; replacement, adjacent, and nested unowned contents survive.

The composer accepts the native picker, drag/drop, and image paste, shows removable chips and errors, blocks sends during copying, and supports attachment-only sends. Project and thread drafts retain their files and newer edits across switches and failed sends. Space Visualize uses the same project draft key. Streamer masking preserves raw attachment names, metadata, clipboard, persistence, and CLI bytes. The resting composer is at most 960 px wide and 109 px high, with narrower-window coverage.

Desktop and browser-development commands use the same typed attachment contract. Development authentication and CSRF checks precede body processing; uploads are serialized, bounded to one file and 30 seconds, with abort cleanup. Ordinary commands retain their 1 MiB limit. Thumbnails use identity-checked raster signatures and revocable blobs. Opening an attachment reveals it safely, including forged image MIME and script content.

## Full verification and review

The final runtime and E2E source was frozen as tree `84d98ad0a3125627f878546b3b7142ffbb40e4ff`. Required local gates passed:

| Gate | Result |
| --- | --- |
| `npm run build` | Passed |
| `npm test` | 621 passed, one existing skip, zero failures |
| `npm run typecheck` | Passed |
| `MODEX_TEST_OPEN_KNOWLEDGE=1 npm run test:e2e` | 199 desktop tests passed in 9.0 minutes, then 7 site tests passed in 13.1 seconds; zero failures or skips |

Build, unit, and typecheck evidence was recorded on runtime tree `37d0b47953e0cbc580e7c763f8496ce910f71b57`; only two E2E files changed before the final full run. Whole-integration SPEC and QUALITY reviews passed. SPEC independently ran 137 focused checks and compared 135 emitted JavaScript files; QUALITY independently ran 230 focused checks. Both reviewers then passed the two-file E2E correction. These automated checks are separate from human VoiceOver acceptance.

The first full run passed 197 of 199 desktop tests and did not reach the site stage. Both failures and the complete run were preserved. The composer assertion expected Plan mode first after Attach files had become the first menu item. Its correction verifies Attach files focus, ArrowDown, and Plan selection.

The other failure expected a 320 px Space sidebar after a 40 px drag and observed 290 px. Its original trace lacked DOM pointer events, so the cause remains unresolved. Five instrumented runs on unchanged runtime reached exactly 320 px with all twelve captured moves delivered. The original panel pair and corrected menu case then passed together (3/3). No resize code, mouse sequence, wait, or width tolerance changed. Passive event recording now attaches delivered coordinates, capture state, handle identity, ARIA, CSS, and actual width on failure. Style and layout reads can affect scheduling; these diagnostic passes do not establish the earlier cause. The final full run passed both panel cases in sequence and preserves the exact assertions.

## Real CLI acceptance

Both installed coding CLIs received a staged image and a separate text file through the actual `AttachmentStore` → `ThreadRunner` → backend path. Runs used disposable Modex homes and empty Git repositories, installed CLI account sessions, agent mode, Auto off, a manually assigned title, and no API-key or automatic approval path. Coding turns remain CLI-only.

The image contains `LANTERN B35D93` and three orange triangles. The separate file contains receipt `FILE-33202e0b9a634a73aac3ed1cecf6ca12` and codename `garden-ember`. Expected values were absent from the prompt. Only copied attachments were made available in each test thread.

| CLI | UTC interval | Result |
| --- | --- | --- |
| Claude Code 2.1.289 | 10:37:52–10:38:01 | Exact image text, three orange triangles, exact file receipt and codename |
| codex-cli 0.162.1 | 10:38:30–10:38:40 | Exact image text, three orange triangles, exact file receipt and codename |

Claude used `Read` on the copied text file; Codex used `cat`. Both actual tool records succeeded. Neither requested approval escalation or produced an error notice. The image remained SHA256 `61bb95969b78087fd47a9a699b2da8d7b009319c3484c4a269c6b67400f3a8a6`; the text remained SHA256 `32fa64efdd672b939d8d0bb51a6815544cd247e8441a8f29a65d00e5fb145ae6` after staging and claim.

These runs used the repaired store in tree `37d0b47953e0cbc580e7c763f8496ce910f71b57`. All 20 source and emitted-JavaScript hashes from both provider receipts match the final build: five modules and their JavaScript per provider (store, runner, Claude backend, Codex backend, and shared attachments). Earlier 08:01/08:02 claim-only runs and 09:26/09:27 complete-source runs are historical evidence; they predate the cleanup correction.

## Composition and evidence provenance

The integration preserves original PR #157 head `5d79f2effe5d2038295bd84b6f7c046bf6596aa0` and applies the four reviewed task patches in order: storage, claims/limits, composer ownership, and development transport. It includes the independently reviewed UI, Space, and Streamer input `08fa5f2aeaa7714959305618da676ef79821778d`. Actual main `fb336e853f02cb8095e45e473bb840d3420f60dc` differs from that input only by three #165 documentation paths. Those historical documents were retained; final attachment status and this report were updated after the full run. The final `apps` and `packages` trees remain identical to the tested freeze.

The corrected attachment-only patch against `08fa5f2` is SHA256 `a7a9408fe46124d117cedf82b3b87fa03c717a98fa094b3446ab521ab48a60e9`. The two-file E2E delta against `37d0b479` is SHA256 `67ed0d9fbf56e912be69ec6720baf3187ac1e7291d8527a6f5758e376cea150d`. These identify the tested source before final documentation reconciliation.

The parent evidence directory is `apps/desktop/.probes/queue-audit/` in the `queue-composer-audit` worktree. It contains the independent review reports and `live-attachments-post-spec/` receipts, items, events, and oracle. The live harness SHA256 is `0787ac1da401d82cd2d752428a3a394e3414c83bfab214bc3d6b0338f0db5ed1`.

The integration worktree retains `apps/desktop/.probes/attachment-final-integration/`: full build/unit/typecheck logs, the first failed full run and traces, bounded diagnostics, focused results, source freezes, final full results, and final main/hash comparisons. The successful full-run log SHA256 is `12bd029fa3816057d48eae0a19cd60e984ab85c0e88694664ae0017831fd5517`. These are local verification receipts, separate from protected checks on the published PR head. Issue #159 closure is recorded separately after protected landing.
