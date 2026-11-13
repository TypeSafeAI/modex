# Code Review real-PR benchmark, 2026-11-13

Val’s November 4 [decision record](../design/code-review.md#open-decisions) replaced comparison with the deleted original screenshots with a benchmark on real PRs against GitHub’s pages. This record supplies a new ten-PR sample after the first usability fixes and #520’s review-comment integration. It preserves literal issue boxes that still require the original comparison. Human keyboard/VoiceOver, native real-provider review, a Val-named disposable-repository write canary and default activation remain separate gates.

## Source and method

The benchmark used signed source `f9bef700390eb300d40424699193b2731d00e36c`, tree `6a241c26d089ac4d7daf3e4b30b23a28257010c5`. That complete tree equals actual protected main `967b703768d040d64456c7d118548b97a3bae35b`, delivered by #520. All 852 qualified runtime/test/dependency inputs and 804 compiled files remained unchanged through the runs. [Source and actual protected qualification](2026-11-13-cr-inline-integration.md#actual-protected-delivery) are distinct from this read-only UI benchmark.

Real Electron, preload, IPC and main-owned read services used BunsDev’s own `gh` login in new private Modex homes. No read handler or remote response was replaced. Test-only bootstrap instrumentation redirected each window’s `show` to `showInactive`; every sampled window remained unfocused. A temporary CLI wrapper admitted only GETs to this repository, its scoped search and account identity. Broad default inbox searches were deliberately refused; their visible refusal cards are excluded from product findings. GitHub’s public overview and Files pages loaded in a separate headless browser without an authenticated browser profile. No provider review, product GitHub write, installed-profile activation or release was requested.

Each comparison selected the canonical PR link through the real input, checked its title/file count/head, navigated Changes and split views, loaded its file list and selected a file. Bracket navigation and F6 were exercised; the selected head was checked again independently afterward. GitHub page titles matched the same PR titles, and captures of both applications were retained privately. These are new-sample, inactive-window observations; the timing stops at visible overview metadata and is neither a paired historical speedup nor whole-app readiness.

| PR | State during comparison | Files loaded | File pages | Visible metadata, ms |
| --- | --- | --- | --- | --- |
| #514 | merged | 58 | 1 | 823 |
| #506 | merged | 19 | 1 | 814 |
| #498 | merged | 151 | 2 | 1,445 |
| #497 | merged | 9 | 1 | 825 |
| #490 | merged | 31 | 1 | 1,349 |
| #475 | open | 23 | 1 | 1,324 |
| #519 | draft | 7 | 1 | 1,339 |
| #513 | open | 11 | 1 | 1,309 |
| #511 | draft | 19 | 1 | 803 |
| #520 | open | 14 | 1 | 799 |

The ten observations range from 799 to 1,445 ms, with a 1,067 ms median. PR states above are historical observations: #520 subsequently merged, and #513 was closed as superseded. This benchmark neither merged #475 nor changed the draft/default-activation gates on #519/#515/#511.

## Additional observed controls

Activity on #514 displayed its real comment and reply. #506 displayed three real review comments, including two with an unavailable current line. Comments filtering retained them. A separate compiled-service control matched all five records’ path/subject/location/reply fields and body hashes against independent GitHub GET responses; it also verified the zero-review-comment case on #520. No raw comment bodies were published in fixtures or this record.

An additional #506 control passed the instructions dialog’s local scope, initial textbox focus and Escape restoration to its trigger at 1440×900 and 900×600. No instructions were saved and no review was started. The PR divider moved from 512 to 544 by keyboard and to 524 by pointer drag. At 900×600 the split collapsed to one pane, both tabs remained usable, and pin/copy/Open in GitHub/Review/instructions/Merge/split/inbox-menu/search controls stayed inside the viewport. These are automated read-only interactions, not a person’s keyboard or screen-reader acceptance.

## First failures and continuation

The first packet completed #514 and #506, then stopped because the probe expected all 151 files on #498 without clicking the actual “Load next 100 files” control. Its continuation loaded both pages, then stopped at a different probe assumption: `]` was expected to select the grouped tree’s second row. The actual shortcut follows displayed diff/API order. On #498, the next diff after `.github/workflows/platform-cli.yml` is `README.md`, while the grouped tree’s second row is `apps/desktop/e2e/fixtures/local-draft-selection.ts`.

The final continuation inspected the actual diff-section path order and verified its selected tree path, completing the remaining eight PRs without replaying the two completed comparisons. The additional controls packet passed separately. Both diagnosed failures, incomplete results and their closed-process receipts remain retained; no production repair, automatic framework retry or all-green first attempt is claimed for these probe corrections.

## Ranked remaining friction

1. Review-thread coverage: the reader now shows the five observed comments, reply and unavailable-line labels. Resolved-thread state, inline placement and comments beyond the first 100 remain outside its coverage. REST-only authority does not authorize a new GraphQL read path.
2. Reading width: reviewed 1440×900 split captures divide the available area among inbox, overview, code and tree, causing long code to wrap into short lines. Tested resizing and one-pane Changes are working alternatives. This is observed usability friction, not a demonstrated acceptance failure.
3. Navigation order: hierarchical tree order differs from bracket navigation’s displayed diff/API order on #498. This is an observed distinction, not evidence that selection failed after the corrected oracle checked the actual order.

Closed-PR inferred-stack unavailability is documented behavior and is not classified as a transport defect. Historical check completeness does not imply current merge authority. Representative visual assessment covered real comments, split layout, GitHub Files, a large PR, a second overview, GitHub’s open-PR page, both instructions dimensions and narrow Changes; it did not compare every retained capture or substitute new images for the original references.

## Retained evidence and acceptance limits

The [published criterion receipt](https://github.com/TypeSafeAI/modex/issues/327#issuecomment-6845313006) has an exact independent body read-back. Private closeout evidence under `2026-11-11/modex-closeout` includes `cr-ten-real-pr-benchmark-combined-audit.json`, a byte/SHA-256 manifest for 55 captures across the two comparison packets and controls packet, `cr-inline-f9-real-read-audit.json`, complete per-packet requests/results, and the original/corrected probe drivers. The capture set includes the partial first attempt. Each sampled Electron PID was absent after app closure; this is sampled process evidence, not exhaustive descendant proof.

Reproduction of these authenticated runs requires the retained private probe drivers and an owned checkout with the same built inputs. The corrected driver derives the app path from its working directory, uses `cr-real-read-inactive-bootstrap.cjs` in that checkout’s ignored `.probes` directory and writes a new private output directory. Its explicit PR list contains the eight remaining cases; the additional controls driver selects #506. Inspect those lists and the fixed private output location before a new sample. This record does not package a portable benchmark runner or claim that its private captures are public repository assets. Repository fixture regressions remain reproducible through the documented pinned-pnpm commands, with authenticated, provider/write and human evidence kept separate.

No issue checkbox changes in this documentation slice. Original-reference wording reconciliation, real native-provider review, the live-write canary, human accessibility and default activation remain unaccepted. The narrower rendered/read evidence above does not close #319 or #322–#327.
