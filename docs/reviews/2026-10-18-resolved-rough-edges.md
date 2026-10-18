# Resolved rough edges

These entries left [Known rough edges](../status.md#known-rough-edges) in `docs/status.md` on
2026-10-18, once the fix for each had landed on `main`. Each is kept as it was written, under the
PR that fixed it, as the record of how the problem was found. Run ids, job ids and paths are as
recorded at the time.

## `iPhone companion` CI flakes, handled 2026-10-09

Fixed in #153 (2026-10-09).

The job failed five times in two days on
five different lines (#133, #141, #148, and twice on #149's branch). The runner's `.xcresult`
bundles showed three causes, none in the app. (1) The tap helper waited on an
`XCTNSPredicateExpectation` over `hittable`; XCTest answers that by fetching the element's
frame in a nested wait, and when the outer wait timed out it interrupted the fetch, so the
element reported a null frame and "Failed to determine hittability" failed the test while
the button sat on screen (run 37927792976; one evaluation took 10 s there, snapshots 2–3 s
each). (2) `typeText` returned while keystrokes were still in flight, so the next tap sent
"Sh" and left "ip it" in the draft, and a tap during a sheet's animation never focused the
field. (3) A SpringBoard prompt appeared two minutes into the paired flow; the app stops
polling while its scene is inactive, so the state the test waited for never came. The
helpers in `apps/ios/ModexCompanion/UITests/XCUIElement+Ready.swift` now poll in plain
loops (no evaluation can be interrupted), wait for a settled, finite frame before asking
`isHittable`, retry the tap until the field has keyboard focus, wait for the typed value,
and answer system prompts during actions and long waits. Timeouts alone (#147) did not
remove any of the three. (4) Found after those landed (run 37983100896, `main` at #154): the
paired flow's `/resume` call timed out while the runner was healthy (its 10 s wait expired
on schedule). The fixture answers only after `CompanionServer.dispose()` finishes, and
`https.Server.close()` waits for a socket the phone opened but never carried through the
TLS handshake, because `closeAllConnections()` only knows sockets that completed TLS; Node's
handshake timeout is 120 s. A slow simulator stretched the outage step to 66 s, so the resume
landed inside that window (green runs finished the step in 10 s). Reproduced locally with the
real fixture and one half-open connection: no reply in 15 s before the fix, 204 in 6 ms after.
`close()` now destroys every accepted socket. The fix's own commit then split its two CI runs:
the pull_request run passed the whole paired flow (resume answered in under a second) while
the push run (38012518622) failed earlier, at the first follow-up. The phone's log shows one
request hitting its 8 s timeout ten seconds before the send tap, no later request failing, and
the reply never showing within 20 s. The fixture writes no log, so that run stays unexplained;
if it recurs, make `fixture.mjs` log each request with a timestamp before anything else.
The CI job also turns off the simulator's hardware keyboard before the first boot, so the
software keyboard appears and the helper's fallback focus check (`app.keyboards`) can see it;
local Simulator settings are left alone.

## Owner-removal test readiness

Fixed in #189 (2026-10-12).

The fixture waits for the displayed branch after launch
and each project switch. Draft persistence alone does not prove the asynchronous branch
lookup has left restart admission. Holding that lookup reproduced the refusal from
macOS job `114750352400`; the corrected test passed three times with the same delay.
That CI run did not record its pending channel. Production admission and refusal behavior
are unchanged.

## Native picker test readiness

Fixed in #190 (2026-10-13).

The attachment test waits for the recovery file before
reading persisted drafts. A delayed file reproduced the `ENOENT` from macOS job
`114881524305`; the corrected test passed three focused runs and the full 274 desktop
and seven site cases. Count, unique-ID, file-content and reload assertions remain;
permanently missing or malformed persistence still fails. App behavior is unchanged.

## `iPhone companion` CI flakes, root cause (2026-10-13)

Fixed in #197 (2026-10-14).

Eight failures in three days (runs
38370101202 and 38216764305 on `main`, six on branches) each named a different line: a
screenshot timeout, "not ready to tap within 30 s; last frame none" three times, typed text cut
off at "Please su", a failed app termination, and two ignored-first-tap assertions. The Session
logs of three red runs and the green run from the same morning (38386254082) tell one story:
GitHub's shared `macos-latest` runners spend 5–30× longer than a developer Mac on every XCTest
round trip, red or green. Single steps reached 15–28 s for "wait for app to idle" (100–135 of
them per run), 25–34 s per app launch, 16–22 s for the SpringBoard "interrupting elements"
check before a tap, and 5–9 s per accessibility snapshot. A run went red whenever one such step
crossed one of the suite's fixed 10, 20 or 30 s budgets; today's `main` failure was a screenshot
attachment hitting XCTest's own 30 s after every assertion in the test had passed. The earlier
rounds (above) each fixed the step that failed last and the failure moved. Now every budget is
`UITestBudget.seconds(base)`, multiplied by `MODEX_UI_TIMEOUT_SCALE` (×4 in CI, forwarded with
xcodebuild's `TEST_RUNNER_` prefix in `Scripts/test-e2e.sh`), screenshots are best-effort
evidence (`attachScreenshot`, an expected failure when the simulator cannot deliver one), and
`Scripts/xctest-activity-times.py` totals a Session log's XCTest steps so the next report starts
from the same numbers. A green run is unchanged by the scale: a budget only matters once it is
exceeded. Steps XCTest bounds itself (launch, terminate, event synthesis) are outside the scale;
one of the eight (a 2026-10-12 "Failed to terminate") was of that kind. A loaded developer Mac
(load 577 on 16 cores during the run) shows a different bottleneck: snapshots stayed at 0.2 s,
but single "wait for app to idle" steps inside `tap()` reached 86 s while the app's 2.5 s
polling and spinner kept it busy, and the unscaled demo test still passed in 187 s because
those waits never touch the suite's budgets. The CI runners are slow in the snapshot path,
which is the one the budgets measure.

## A resumed Claude session could end a turn with no reply (fixed 2026-10-13)

Fixed in #204 (2026-10-14).

When Modex
stops a turn while a background task is still running (Stop, or the 30-minute cap), the next
message's `claude --resume` first replays that stopped task as a turn of its own: a
`task_notification`, an `init`, and a success `result` with `num_turns` 0 and no text, and only
then the `init` of the turn that answers the message. Modex ended the turn on that result. The
message and its routing were persisted and nothing else; the thread went idle; the CLI did the
real work unheard, for an hour on 2026-10-09 (thread `52868298`). Reproduced outside Modex by
stopping a `claude -p` turn mid-background-task and resuming it (claude 2.1.296). The backend now
holds a result from a turn that never called the model until the real turn answers, or the idle
window passes; and a turn that ends with no items at all becomes a failure card with Retry.

## `iPhone companion` `/resume` timeouts (2026-10-16)

Fixed in #265 (2026-10-16) and #271 (2026-10-18).

Three paired-flow failures on 10-15/16
(38707861067, 38747016392, 38832248437) timed out on the paused-Mac `/resume` call, which green
runs (38832248437 attempt 2, 38836144274) answered in 0.1 s. The simulator's unified log
(in the xcresult's `simctl_diagnostics/<device>/system.logarchive`) shows two causes. First, the
test runner's first URLSession use came at that step, and on a freshly booted simulator its
setup (cfprefsd, nsurlsessiond's storage container, trustd) took 42 s in 38747016392, so the
POST never left the runner, and 19 s in 38707861067. The resume now goes over a plain socket
(`UITests/LoopbackPost.swift`) with the suite's scaled budget. Second, in 38707861067 and
38832248437 the POST did reach the Mac, but the fixture neither answered nor restarted the
companion within 8–10 s, while it exits at once on SIGTERM at the end of the job. 38848571338
failed the same way at the first reply: the fixture left a snapshot unanswered and a TLS
ClientHello unanswered for 5–8 s each, the app marked the Mac disconnected, and the
`create-thread` tap landed on the disabled button 0.2 s later. Locally the fixture answers
`/resume` in 3 ms after 8–80 s outages, and `dispose()` returns at once with a connection in
any state. To find why the CI fixture went silent, `fixture.mjs` now logs the phone's calls,
the pause/resume lifecycle, and every event-loop stall of 1 s or more with the CPU time,
major faults and involuntary context switches it saw, so the next failure's job log says
whether the process was busy, paging or starved. The first two failures after it (38890707807,
38898248332) say paging: stalls of 29–31 s that used 24–37 ms of CPU, with 143–164 major faults,
550–600 involuntary switches and no file I/O. The runner was short of memory while the simulator
ran; both passed on a rerun. A longer budget would only hide this. Sampling the whole job (#271)
found the cause: the simulator's own first-boot work. In 39095765816, two and a half minutes into
the paired test, six wallpaper poster extensions (260–300 MB each) started at once beside News,
Fitness and Health. Free memory fell to 28%, swap rose from 0 to 942 MB, and the fixture stalled
for 38 s, in a run that passed only because no wait was open then. The job now boots the
simulator before `pnpm install`, so that burst lands during the build. In both runs since
(39097082261, attempts 1 and 2) it came about 3 minutes after boot, before the paired test
started. The paired test then had no stall longer than 2.2 s and took 7–9 min instead of 10–14.
