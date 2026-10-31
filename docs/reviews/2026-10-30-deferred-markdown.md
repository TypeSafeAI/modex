# Deferred Markdown for long threads, 2026-10-30

Why the approved 500 ms cold-open gate (`e2e/transcript-measure.spec.ts`, Val, 2026-10-22) failed on hosted CI, and the change Val chose on 2026-10-30 ("Defer offscreen answers"). The gate, its limit and its five-launch method are unchanged.

## Hosted variance, before the change

The `[transcript-budget]` line of every completed hosted `unit + e2e (macOS)` job from 2026-10-30 08:41 to 17:29 UTC (34 jobs; one printed no line), all Apple M1 (Virtual), 3 cores, except one Apple M2 Pro (Virtual), 5 cores:

- 33 medians: median 377.7 ms, minimum 222.8 ms, maximum 781.9 ms; three above 450 ms, one above 500 ms.
- The failure, merge-queue run [41056164788](https://github.com/TypeSafeAI/modex/actions/runs/41056164788) on `b033809`, measured 782, 1022, 822, 720 and 729 ms. `b033809` is `9f85d61` plus one CI-only change (#456, the Linux KWallet5 pin). Run [41055938841](https://github.com/TypeSafeAI/modex/actions/runs/41055938841) on `9f85d61`, started two minutes earlier, measured a 436.1 ms median. The application under test was identical, so the spike was the runner, not the code.
- Earlier recorded failures: 971.8 ms (#431's queue run) and 2019.2 ms (run 40764795777).

The typical hosted median sat about 120 ms under the limit, so ordinary runner variance was enough to fail it.

## Where a cold open went

Local, Apple M5 Max (18 cores), from a Chromium trace of the first open in each launch: the 7 ms `thread:items` read was negligible. One renderer task of 150–180 ms held the cost, about 110 ms of it parsing Markdown for the fixture's 200 visible final answers (`fromMarkdown` from mdast). Two cheaper candidates were measured and rejected:

- Mounting never-shown folded work only on first expand cut rendered items from 1,400 to 400 but left the open at about 176 ms: folded work was not the cost.
- Creating the GFM extensions once instead of per parse made no difference beyond run-to-run noise (Node, cold, four paired runs: 110/104, 176/237, 154/121, 127/128 ms).

## The change

`DeferMarkdown` (`Markdown.tsx`) is provided around every transcript turn before the newest eight (`EAGER_TURNS`, `ThreadView.tsx`). Markdown inside one shows its text as written (`.md-deferred`, `data-markdown-deferred`) until it comes within 1,500 px of the transcript's view; it then parses once and stays parsed. Text already parsed this session renders at once. The newest turns, including any streaming one, parse as before. Chromium's scroll anchoring keeps the reader's place while answers above it parse and grow.

The budget probe now also waits until the last answer is parsed Markdown, so a deferred answer cannot count as opened.

## Results

Throttled cold opens (a local probe that applies `Emulation.setCPUThrottlingRate` 3 to the first open of each launch; three five-launch runs each):

| | medians (ms) |
| --- | --- |
| before | 806, 834, 870 |
| after | 327, 312, 340 |
| before, unthrottled | 197 (a single five-launch run) |
| after, unthrottled | 101, 102 |

First-pass `pnpm build && pnpm test && pnpm test:e2e` on this branch (local, M5 Max): build and unit tests passed. E2E finished with 477 passed, 7 skipped and 1 failed. The five-launch median was 87.7 ms. The failure was `e2e/companion.spec.ts:44`: the copied pairing link read `192.168.2.1-rotated` where `10.0.0.1-rotated` was expected, from the system clipboard. It passed when rerun alone, together with the new spec (3 passed). It is unrelated to the transcript and is recorded as observed.

New coverage:

- `e2e/markdown-defer.spec.ts`: the newest answer parses at once; the oldest shows as written, parses when scrolled to, and stays parsed. A middle answer brought into view stays within 2 px while the answers above it parse. As a negative control, with `overflow-anchor: none` the second case failed ("moved from 45.2 to -50.7").
- `test/markdown-render.test.ts`: deferred text renders as written, escaped; text parsed before renders parsed inside a deferred turn; `RenderCache.has`.

## Not covered

- Assistive technology reaching a deferred answer without scrolling near it would read the Markdown as written. VoiceOver moves the view as it navigates, which should parse the answer first. This is untested by a person, and rows C1–C5 remain deferred.
- Copying a deferred answer's text copies it as written. That is the source Markdown, not the rendered text.

## Hosted CI on the PR, 2026-10-31

[Run 41163979727](https://github.com/TypeSafeAI/modex/actions/runs/41163979727/job/124427436348) on `#463`, Apple M1 (Virtual), 3 cores, Node v24.22.1, passed on its first attempt. Desktop E2E had 481 passed and 4 skipped in 28.4 min, and site E2E had 7 passed. The five-launch samples were 129.9, 126.2, 129.4, 136.1 and 181.1 ms, a median of 129.9 ms. Hosted runs on the same runner type before the change had a median of 377.7 ms over 33 runs. One run is not a variance study; later queue runs add to it.
