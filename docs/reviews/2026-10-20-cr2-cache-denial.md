# CR-2 visibility-loss cache repair

This is the user-authorized separate `cr2-cache-denial` session. It does not modify
`cr2-read-service` or the CR-3 owner's branch. The producer reviewed is PR #349 at
`d31f661d0adc558d23ca1417cf6b080478a934f9`.

## Behavior and regression evidence

A successful overview followed by HTTP 403/404 and then offline previously returned
the old overview as stale. Both regression cases failed on the producer implementation.
An overlapping context read also returned ready after a later PR denial; that race
failed before the in-flight invalidation repair.

An authoritative PR visibility failure now evicts related retained overview, activity,
checks, files, context, resolved links and affected inbox pages. It discards known
revisions and transport representations, and prevents reads already using the repository
from restoring data. Other repositories keep their offline fallback. Rate limits remain
transient; SSO denial, 404 and 410 invalidate visibility. Missing individual endpoints
also evict their own retained result and conditional-response cache entry.

The service regression suite passes 42/42, with no skips. It includes ordinary offline
fallback, unrelated-repository retention, 403/404/410, SSO versus rate limits, and the
in-flight context race. The original failing outputs are preserved externally.

## Authenticated service smoke

Ran `node apps/desktop/.probes/cr2-cache-smoke.mjs` through the real CodeReviewService
and gh transport, without a replacement handler or transport. All five operations
(connection, resolve, overview, files, context) returned ready.

- Host: github.com; account: BunsDev, id 68980965.
- Repository: TypeSafeAI/modex, stable id 1386876170; PR #349.
- Base: `ac7f743735d7ce5db2e0f1fad2fe291ab54c96db`.
- Head: `d31f661d0adc558d23ca1417cf6b080478a934f9`.
- File list: 15 files; context: first five lines of
  `apps/desktop/src/main/engine/code-review/read-service.ts` at that head.
- Calls were GET-only; no credentials or source contents appear in the log.

This proves service reads, not an authenticated renderer/IPC navigation journey.

## Remaining integration gate

PR #346 remains open at `8883428645e16ab7eab053cff561a3181041aec7`.
Its CR-3 owner owns #322's authenticated navigation gate. Next action after acceptance
of the CR-2 repair: integrate the accepted service with #346 in an owned workspace,
exercise the real main/IPC path, and run full UI E2E with first failures/skips retained.
The overview/diff producer panes remain #323/#324 dependencies; no visibility switch,
review/write controls, merge, release or deployment is enabled here.

## Evidence location

`/Users/buns/Documents/Codex/artifacts/modex-cr2-cache-denial/` contains the original
failing regressions, service suite, build/typecheck/unit logs and authenticated smoke.
Final SHAs and complete suite outcomes are recorded in the external checkpoint.

## Independent review follow-up

Before merge, independent review reproduced three remaining cases: an overlapping inbox
refresh restored a denied PR summary; denial of one file slice left other slices cached;
and a denial during asynchronous identity confirmation could still publish content.
Four regression cases failed before the follow-up repair (contents 403 and 404 separately).
Retained results now record bounded provider-resource dependencies, so every slice of a
denied resource and overlapping reads are invalidated together. A PR denial also refuses
pending searches whose repository membership is not yet known and clears old search ETags.
The reply boundary checks invalidation again after confirmation. Unrelated completed
pages/files and normal offline/rate-limit fallback remain available.

The follow-up also preserves partial inbox coverage: a denied repository lookup removes
its rows from both concurrently read groups, while accessible repositories remain visible.
Two additional failing-first tests cover ordinary denial and a same-repository 200/403
race followed by another refresh. Denied repository metadata cannot be restored by an
older overlapping lookup. First failing logs and the intermediate full-suite failure
are retained; final validation is recorded separately.
