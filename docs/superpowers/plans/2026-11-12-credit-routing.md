# Credit conservation implementation plan

> **For agentic workers:** Use superpowers:executing-plans in this session. Steps use checkbox syntax for tracking.

**Goal:** Automatically conserve low allowances and credits using account-bound CLI telemetry.

**Architecture:** Normalize CLI telemetry in routing/quota.ts. Auto consumes fresh snapshots alongside model ladders, excludes exhausted candidates and applies conservation without losing sessions. Backend adapters retain credential ownership.

**Tech Stack:** TypeScript, React, Electron, Node test runner, Playwright, pnpm.

**Spec:** docs/superpowers/specs/2026-11-12-credit-routing-design.md

## Global constraints

Coding remains CLI-only. No inference balance probes, direct provider calls, invented dollar costs, lost session bindings or cloud fallback for local-only runs. Prose paragraphs use one logical source line. Keep all changes in the owned credit-routing worktree.

## Review focus

- Included quota and purchased credits must never be conflated.
- Unknown or expired readings cannot prove a candidate healthy.
- Bound accounts must survive asynchronous routing and selection changes.
- Warm-cache fast mode must not override conservation.
- Local-only execution must never query cloud usage.

### Task 1: Account-bound balance telemetry

**Files:** Create routing/quota.ts and test/routing-quota.test.ts; modify backends/types.ts, codex.ts, account-codex.ts and claude.ts with protocol tests.

**Interfaces:** Backend.quota(account?: string): Promise<QuotaSnapshot | undefined>; quotaState(snapshot, policy, model?, now?) returns a typed state and reasons. Codex uses only account/rateLimits/read; Claude caches rate_limit_event by turn account.

- [x] Write tests for thresholds, malformed/stale/reset readings, included versus paid credits, model scopes and synthetic CLI reads/events.
- [x] Run focused tests and observe failures before implementing.
- [x] Implement telemetry normalization and account-bound adapters.
- [x] Run focused tests to green.

### Task 2: Conservation in Auto and runner

**Files:** Modify routing/router.ts, routing/policy.ts and runner.ts; add policy/router/runner regressions.

**Interfaces:** RouteInput carries captured account ids; RouterOptions.quota reads each account-bound backend; DecisionInput.quotas supplies snapshots. Existing session, budget and effort controls remain authoritative.

- [x] Write failing tests for low-balance choices, hard tasks, warm fast caches, unknown alternatives, exhaustion and local isolation.
- [x] Implement filtering, conservation, per-account catalog caching and stable runner account capture.
- [x] Run routing and runner regression tests to green.

### Task 3: Settings, documentation and qualification

**Files:** Modify shared/types.ts, engine/store.ts, renderer/components/SettingsDialog.tsx, docs/auto-routing.md and docs/status.md; add settings and e2e coverage.

**Interfaces:** RoutingPolicy.conserve_credits defaults true; low_quota_percent defaults 20; low_credit_balance defaults 10 provider units.

- [x] Write failing persistence/default and settings UI checks.
- [x] Implement validated settings and explanatory product copy.
- [x] Update routing docs and status with exact local evidence.
- [ ] Run pnpm build, pnpm test and pnpm test:e2e; record environmental failures without claiming acceptance.
- [ ] Review the full diff and retain a reviewable branch with signed commits when signing is available.
