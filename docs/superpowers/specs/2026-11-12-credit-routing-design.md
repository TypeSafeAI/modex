# Automatic credit conservation

Approved by Val in this session: extend Auto with quota-aware conservation while retaining CLI-only coding, conversation context, and clear receipts. Automatic activation is the selected approach; manual economy mode remains available.

## Behavior

Default conservation thresholds are 20 percent remaining included allowance and 10 provider credit units when included allowance is unavailable or exhausted. Both are configurable; conservation can be disabled. Read Codex account/rateLimits/read through the account-bound CLI, and retain Claude rate_limit_event telemetry from ordinary turns. No balance probe may run an inference turn or make a direct provider request. Missing, malformed, stale (over five minutes), expired-window and unsupported readings are unknown, never full credit.

Conservation removes discretionary quality/learned tier increases for light work, applies economy routing to light tasks, caps reasoning at high and disables fast mode. Deep reasoning, risky and complex tasks retain their capability target. Existing hard premium and effort limits still win. Warm caches retain their existing model with cheaper per-turn effort, unless the model is exhausted. No account or backend switch may discard an existing session. On fresh threads, existing backend-switch permissions allow a healthy alternative to an exhausted or low account. Exhausted candidates are excluded; if no permitted candidate is usable, stop before coding. Unknown telemetry never establishes that an alternative is healthier.

Included allowances and purchased credits remain distinct. An empty purchased balance does not exhaust an account with remaining included allowance. Positive paid credits can sustain a route after included allowance is exhausted, in conservation mode. Dollar prices are unavailable from current catalogs; model tiers and supported effort are estimates, not exact cost comparisons. Receipts explain balance state, reset time, conservation and cache decisions.

## Approaches

Selected: integrate telemetry with Modex Auto, retaining existing account and CLI ownership. A separate gateway would change inference architecture and is excluded by repository rules. Manual-only economy mode cannot respond automatically to low balances.

## Verification

Synthetic CLI protocol tests prove account scope and no inference during reads. Policy tests cover threshold boundaries, credits versus allowance, unknown/stale/reset data, hard tasks, cache reuse, paid fast mode and exhaustion. Runner tests prove blocked routes never execute, session bindings survive, and local-only runs never request cloud balances. Settings tests cover persistence and configurable defaults. Run the repository build, unit suite and UI e2e checks; distinguish local evidence from CI, release and installed acceptance.

## Delivery audit refinements

The final pre-merge review adds replacement admission to all automatic model/account attempts, proactive metadata-based rotation within the existing enabled pool setting, an account-specific refused-model cooldown, and affirmative available-credit handling when the numeric amount is unknown. Replacement admission preserves the task minimum rather than the cache holder's price tier, reuses typed judgments, and shares the original premium budget. Quota/capability rejection must not teach a larger-model preference. Conservation keeps the opening-message title to avoid an auxiliary paid coding turn. These repairs complete the approved conservation behavior; coding remains CLI-only and exact dollar optimization remains outside the available metadata.
