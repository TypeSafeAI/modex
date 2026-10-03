# Jev settings and routing review

Scope: issues [#40](https://github.com/TypeSafeAI/modex/issues/40) through
[#50](https://github.com/TypeSafeAI/modex/issues/50), based on main
`3c2bb240059b3e1bec9264f1e57fa885096c6bf9`. This is an offline implementation and
regression review; it does not establish live provider credentials, credits, pricing,
or quality. Coding turns remain CLI-only and existing approval/sandbox rules apply.

## Acceptance checklist

Every published criterion is part of the review scope. A green suite alone is insufficient;
the reviewer must inspect the behavior and its integration before recording a disposition.

| Issue | Required behavior | Evidence to inspect |
| --- | --- | --- |
| #40 | CLI-only never falls back to HTTPS; Auto prefers CLI; HTTP skips CLI; fake key/detection matrix covers missing credentials. | Router setup and transport regression cases. |
| #41 | Relevant successful saves invalidate setup for status/test/route/follow-up; learned history survives; stale setup/provider work cannot alter new configuration. | Settings IPC, Router generation fencing, configuration-change tests. |
| #42 | Dirty judge configuration cannot masquerade as tested; exact saved transport/executable/model identified; edits invalidate visible results. | Settings test gating and fake-IPC e2e. |
| #43 | Immediate credential/reset actions are clearly separate from drafts; reset is confirmed; Cancel/Escape/backdrop semantics are explicit; credentials remain masked/encrypted. | Settings actions, secret storage, confirmation/cancellation e2e. |
| #44 | Existing sessions never switch under the no-session option, regardless of judge continuity score; no-session availability/capability cases preserve consent. | Policy and deterministic switching cases. |
| #45 | Normal, pinned, sparse/unknown-capability and no-list routes respect effort/premium caps; impossible safe selection stops before backend execution. | Policy hardening and runner ceiling tests; blocked routes excluded from Fit. |
| #46 | Configured/untested, explicit success and failure are distinct; last explicit result has configuration identity; old successes cannot validate edits; no automatic provider ping. | Router test/status, reset/race tests and settings e2e. |
| #47 | HTTP reports CLI not checked; only failed detection can report missing; transport/detected executable feedback is accurate. | Router setup and settings transport feedback cases. |
| #48 | Four navigable sections; persistent actions; Auto section immediately accessible; keyboard focus containment/return, small viewport and zoom are exercised. | Settings structure/styles and layout e2e. |
| #49 | Validated judge model and allowed backend controls; empty selection defined; compatibility and save/reopen round trip; restrictions affect routing. | Settings advanced controls, Store migration and policy cases. |
| #50 | Save is awaitable; persistence failure retains draft/error/retry; duplicate submissions/dismissal blocked while pending; refresh failure handled separately. | Settings/App persistence and delayed/rejected fake-IPC e2e. |

## Review and validation

The independent `gpt-6-sol`/`xhigh` reviewer inspected the complete integrated diff and
published issue bodies. All eleven acceptance checklists have a source and offline regression
disposition; no material finding remains open in the reviewed tree:

| Issue | Review disposition |
| --- | --- |
| #40 | Pass: CLI-only failure uses the heuristic; Auto prefers CLI then eligible HTTPS; HTTP skips CLI detection. Transport matrix uses fake key and CLI detection. |
| #41 | Pass: persisted transport/executable/model changes reset cached setup without clearing Fit; generation checks keep old test/provider failures from changing new status. Tests cover replacements and failed writes. |
| #42 | Pass: changed transport, executable, or judge model disables Test and invalidates visible verification; effective tested identity accompanies the result. Fake IPC exercises draft changes. |
| #43 | Pass: immediate key/clear/reset wording and reset confirmation explain Cancel semantics. Pending immediate actions now block dismissal; password input stays masked and fake IPC avoids real secrets. |
| #44 | Pass: a backend can switch only with explicit setting and no existing session; continuity scores do not grant authority. Deterministic tests cover availability and allowlists. |
| #45 | Pass after review fix: selected and pinned efforts stay within advertised capabilities and ceilings, or Auto stops before backend execution. Spent budgets now also block top-tier-only and pinned top-tier routes; pinned premium turns count toward the limit. |
| #46 | Pass: status distinguishes configured/untested, explicit success, and failure. Last test records transport, executable, model, time, and result; resets and draft changes invalidate old verification. Status inspection makes no provider request. |
| #47 | Pass: HTTP says CLI is not checked; CLI availability feedback follows detection and selected transport. Fake transport matrix covers all modes. |
| #48 | Pass: four navigable sections with fixed Save/Cancel, Auto section on open, focus containment/return, narrow/zoomed layout, and keyboard tab order. |
| #49 | Pass: judge model and backend allowlist round-trip through persistence and routing tests. Empty list keeps the current backend; legacy Mock entries remain controllable. Existing sessions keep their backend/model/session until a permitted future decision. |
| #50 | Pass after review fix: save awaits persistence, blocks duplicate submission and dismissal, retains a failed draft for retry, and distinguishes refresh failure. A successful save response now updates renderer state even if the full-state refresh fails. |

Review findings and fixes:

- **P1, premium limit bypass:** `routing/policy.ts` could choose a tier-3-only model after the
  daily target had been reduced to tier 2, and low-confidence pinned routes could keep tier 3.
  `routing/router.ts` also omitted pinned premium routes from the daily counter. Both paths now
  stop when the budget is spent, and every selected premium Auto route counts. Deterministic
  policy and router tests cover the before/after cases.
- **P2, stale configuration feedback:** `SettingsDialog.tsx` could let its opening status
  request resolve after a successful immediate key action and replace fresh status. A request
  generation now rejects the stale response; fake IPC delays and resolves it in a regression test.
- **P2, pending operation feedback:** `SettingsDialog.tsx` ended the visible Test pending state
  before the status refresh finished, while its operation guard still rejected actions. It also
  allowed dismissal during immediate operations. The dialog remains busy through refresh and
  blocks Cancel, Escape, and backdrop dismissal until each operation settles. Fake IPC checks
  delayed refresh and dismissal.
- **P2, saved-state refresh failure:** `App.tsx` persisted settings and closed the dialog, but
  a failed subsequent `state:get` left the renderer's settings snapshot stale. The successful
  `settings:update` response now updates that snapshot before refresh; a fake refresh failure
  proves the saved value is present when Settings reopens.

The reviewer re-read the final `origin/main..HEAD` changes after these fixes, including
route blocking before backend execution, Fit counting, async status ownership, save retry,
and settings dismissal. `npm run build` passed. Focused offline unit checks passed 39/39;
the broader settings/review Playwright group passed 20 tests with one macOS-only skip on
Windows. The required full suite and
hosted macOS protected check remain final-head delivery gates, to be recorded by the
integration owner. No live provider or coding turn was invoked for this review.

The first preparatory delegations inherited the default model because their
full-history forks ignored overrides. Their changes were retained as starting code; all
four finishing implementation lanes were then delegated with fresh contexts and verified
from session records to use `gpt-6-luna` with `high` reasoning. The final independent
review was verified from its session record as `gpt-6-sol` with `xhigh` reasoning. The requested fast
service tier was unavailable in the delegation interface and was reported to the user.

Baseline platform limitations were reproduced before integration: the Windows suite assumes
POSIX modes, path separators and login shells in several existing tests. The Linux GCC
build also reports pre-existing unused-parameter/unused-result warnings as errors in the
terminal supervisor. An isolated Linux harness suppresses only those two warning classes;
it is supplemental evidence, not a replacement for the required unmodified macOS CI job.
