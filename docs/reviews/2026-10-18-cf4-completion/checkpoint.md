# CF-4 implementation and acceptance checkpoint

Issue #277, parent #273; contract #274 / landed #282. No merge or release authorized.

## Ownership and exact source

Owned branch/worktree `cf4-completion` / `.worktrees/cf4-completion`; created and checked with
`scripts/worktree.sh`. Primary checkout and other sessions were preserved.
Created from `d3711c6d904513ee74ede494ae8b13908ffdfbcd`, then deliberately fast-forwarded to
parser PR #283, `74833f78b82b901208db807bdc6ade8e7a718efa`. #283 remains open as of this
checkpoint; this follow-up is intended to stack on `cf4-markdown-parser`.

Signed implementation commits, each verified with `git verify-commit`:

- `cce0a4011e97bb2b1bdd9322100ce471945ee848`: typed phase/outcome fidelity, explicit turn grouping,
  stable Markdown nodes/context and bounded session reader state.
- `00576beecc03f162a4ece3847632e75a4921fe7d`: continuity/theme/keyboard tests, benchmark,
  old mock assertions updated to stop inventing final phases.
- `c974d0f3028d269587ec7d5d047a63b5fbc5af17`: explicit failed/denied assistant reply labels.

## Behavior and regression evidence

Typed records follow `origin.turn`; only the latest attempt's explicit `final` is treated as
its answer. Legacy records keep their isolated historical adapter. Failed, denied, interrupted,
unknown and pending rows remain visible. Reasoning summaries retain their label during streaming;
unavailable reasoning does not imply hidden text can be inspected.

The existing micromark/CommonMark/GFM implementation from #283 remains the parser. Raw HTML/MDX
is inert, images become safe links, Copy only copies text, links use the existing main-process
http(s) validation. No inference path, approval broker or remote image fetch was added.
Streaming keeps React boundaries stable and conservatively parses context-dependent documents
whole. Session reader state stores only expansion/scroll preferences, bounded to 100 threads and
1,000 expansion entries each. Draft ownership remains in App; ThreadView is keyed by thread ID.

Observed RED then GREEN regressions cover typed unspecified/non-success work (six layout
failures), late typed grouping, Copy focus/selection across settlement, reference/list context,
thread-return expansion, reasoning labels and failed/denied reply labels. Logs are beside this
file. Renderer unit tests load source TSX through Vite SSR. Initial theme captures were invalid
because raw settings IPC did not update App; tests now select Settings radios and assert the
active theme. Chromium's equivalent `0s`/`0ms` reduced-motion values are both accepted.

## Verification

Node v24.18.1; pinned pnpm 10.34.5; macOS Darwin 25.6 arm64, Apple M3 Max.

| Command | Result / scope |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed |
| `pnpm build && pnpm typecheck && pnpm test` | Passed on implementation through cce0a401; full-build/typecheck/test logs |
| Unit suites | Worktree 109/109; core 16/16; desktop 1,538 passed, 16 existing skips of 1,554; native/update 21/21; site 10/10; Store 16/16 |
| `pnpm typecheck` | Passed at c974d0f; head-typecheck.log |
| Desktop Playwright app, approvals, layout, routines specs | 36/36; corrected-specs.log |
| `pnpm --filter @modex/site test:e2e` | 7/7; site-e2e.log |
| Desktop Playwright typed-turns, conversation-rendering, conversation-continuity specs | 14/14 on c974d0f source; outcome-green.log |
| `pnpm test:e2e` | 323 passed, 3 skipped, 10 failed; dispositions below (full-e2e.log) |

The last focused run used a production Vite build in `apps/desktop/.probes/outcome-renderer`
and Electron's `MODEX_DEV_URL=file://.../index.html`, preserving the default renderer used by
the concurrent broad run. Commands: `pnpm --filter @modex/desktop exec vite build --outDir
"$PWD/apps/desktop/.probes/outcome-renderer"`; then the three Playwright specs with that URL and
`MODEX_SCREENSHOTS="$PWD/docs/reviews/2026-10-18-cf4-completion/screenshots"`.

## Captures

`screenshots.json` records SHA-256, CSS viewport, DPR and source commit for all 14 PNGs.
Markdown captures cover Graphite, Jev and OpenCoven at 900×600 and 1280×900. Typed mixed turns
cover all three themes at 900×600. State captures cover live, waiting, failed, completed and
reloaded conversations. Minimum-size themes, reference Coven and waiting/failed/completed
captures were visually inspected. Tests cover sustained updates, scroll-away/Jump, thread
switch/restore, draft preservation, expansion, keyboard Copy/fold, selection, pending Deny focus,
reduced motion and long-code overflow contained within its code block.

## Measured performance and limits

Run `pnpm --filter @modex/desktop exec node scripts/benchmark-transcript.mjs` from the worktree root. `performance.json`
contains all three alternating trials and source hash (Markdown unchanged since cce0a401).
200 unique mixed messages / 306,290 bytes; 24-character streaming increments. Medians:

| Vite SSR parse/render | Parser base #283 | This implementation |
| --- | ---: | ---: |
| Cold transcript | 150.01 ms | 127.40 ms |
| Reopen | 22.50 ms | 7.72 ms |
| Plain stream, mean per delta | 0.416 ms | 0.329 ms |
| Context-sensitive stream, mean per delta | 0.307 ms | 2.303 ms |

Contextual baseline splitting is semantically wrong; its timing is not an equivalent-output
comparison. Correct whole-document parsing costs more. Load was 40.2/50.8/75.1; trial variation
is substantial. These are parser/SSR measurements, excluding IPC, browser layout and provider
latency, and do not establish a universal speedup or a native-app performance budget.

## Remaining acceptance gates

- Real Claude and Codex turns in the native app, including provider-specific partial output,
  interrupted/retried work and pending decisions. Fixtures do not prove provider acceptance.
- Human keyboard-only and VoiceOver review at minimum size and each theme. Automated keyboard,
  DOM, contrast and screenshot tests do not count as human acceptance.
- PR CI and maintainer review before landing; #283 stack dependency must be handled first.

## Full-run failure disposition and handoff

`pnpm test:e2e` finished with exit 1 after 39.3 minutes: 323 passed, 3 skipped, 10 failed.
It began before the corrected mock expectations and used the frozen cce0a401 renderer.
Six app failures and two approval failures were old implicit-final expectations or shared-fixture
cascades; complete corrected app/approvals/layout/routines specs passed 36/36. The owner-removal
Quit case timed out waiting for close, then passed alone 1/1 with no code change. Space's page
create/edit/relaunch test hit its 90-second limit. Its concurrent rerun also timed out in another
launch/relaunch case and was interrupted (exit 130); this is retained in space-concurrent-recheck.log.
The serial final-head run after rebuilding the default renderer passed 26/26: all 12 Space
cases and all 14 CF-4 cases (head-final-e2e.log), with no code changes for those timeouts.
Command: `pnpm --filter @modex/desktop build:renderer && pnpm --filter @modex/desktop exec
playwright test e2e/space.spec.ts e2e/typed-turns.spec.ts e2e/conversation-rendering.spec.ts
e2e/conversation-continuity.spec.ts --output=/tmp/cf4-head-final-results`.

The three skipped native Knowledge cases are e2e/knowledge.spec.ts lines 151, 236 and 331:
CLI-agent knowledge editing, existing editor connection, and real Open Knowledge install/lifecycle.
They are not claimed as passing. The failed desktop command prevented its chained site run;
the separately invoked site E2E suite passed 7/7.

Final-head typecheck passed. The default renderer rebuild passed. No single all-green full-suite
run is claimed: use the full-run log and explicit corrected/final reruns together. Native-provider,
human acceptance and remote CI remain gates before landing. No merge or release was performed.

Keep the owned worktree until the PR is merged and its lifecycle/recovery gates permit removal.
