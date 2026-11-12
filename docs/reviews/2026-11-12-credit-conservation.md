# Automatic credit conservation: local qualification

The tested runtime candidate is `98a0bde80c157b6b132a83566f6ddde9f1d4bf4f`, tree `f312dfca6f865ba69168a37ed29e71ccee6d48be`, on the isolated `credit-routing` branch. Feature commit `84a5334` was followed by the review repair `98a0bde`; both are signed. This receipt and the status update are documentation-only follow-up changes.

Auto now consumes account-bound CLI quota metadata, keeps included allowance distinct from purchased credits, conserves low balances at configurable 20% / 10 provider-unit defaults, explicitly overrides saved fast settings, preserves capability and session ownership, and excludes exhausted candidates. Missing or stale readings remain unknown. Price estimates use existing model tiers and supported effort; no dollar savings are asserted. [Behavior](../auto-routing.md#automatic-credit-conservation), [approved design](../superpowers/specs/2026-11-12-credit-routing-design.md).

| Verification | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed |
| `pnpm build` | Passed |
| `pnpm typecheck` | Passed |
| `pnpm test` | 2,515 passed, 36 explicit skips, zero failures or cancellations |
| `pnpm test:e2e` desktop | 516 passed, 11 explicit skips, zero failures; 527 scheduled cases |
| `pnpm test:e2e` site | Seven passed, zero skips or failures |
| Focused backend, policy, runner and settings regressions | 173 passed, zero skips or failures |
| Installed Codex 0.167.2 metadata read | One quota window normalized; credit metadata reported; zero inference turns |

The Electron conservation test verifies enabled defaults, both threshold edits, saved values on reopen, disabling and persistence to the settings file. Its captured screen was inspected. Synthetic protocol checks verify that quota reads never start inference, both CLI transports explicitly disable inherited fast mode during conservation, and account selection changes cannot redirect an admitted turn. Local-only execution requests no cloud identity or quota.

An independent review of `84a5334` requested five repairs: Retry admission and fast-mode retention, fallback to an alternative with unknown quota, selected-model low buckets, non-light capability preferences, and unrelated exhausted buckets blocking warm caches. Each was reproduced with a failing behavioral regression before repair. Additional boundaries cover intervening blocked retries, exhausted alternative capacity, suitable replacement of an exhausted cache holder and unrelated capability switches. All focused and full suites pass after the repairs. There are no deferred minor findings.

These results establish local source, synthetic protocol and rendered Electron behavior, plus one installed Codex metadata read. They do not establish live coding or billing behavior, live Claude account compatibility, installed-release acceptance, hosted CI, merge or publication. Claude remains unknown until its ordinary stream reports usable metadata; unsupported account/provider telemetry remains unknown. Raw logs, the screenshot, review findings, signature checks and a structured verification receipt are retained outside the checkout in the session's private artifacts directory.
