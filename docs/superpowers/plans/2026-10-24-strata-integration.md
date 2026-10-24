# Strata Integration Implementation Plan

> **For agentic workers:** Execute inline in this session using superpowers:executing-plans. Track evidence in the dated review receipt.

**Goal:** Run explicitly selected Strata models through native Codex from Modex.

**Architecture:** Consume PR #401's main-owned connection store and LM-1 identity. Add an isolated local execution service around the existing Codex backend, then bind thread admission and UI to it.

**Tech Stack:** TypeScript, Electron, React, Node test runner, Playwright, codex app-server.

**Spec:** `docs/superpowers/specs/2026-10-24-strata-integration-design.md`

## Global Constraints

Preserve native execution and approval authority, existing cloud behavior, exact opaque IDs, signed reviewable delivery and original failed evidence. No model downloads, global configuration changes, merge or release. Knowledge and Space notes remain read-only.

## Review Focus

- Stale or forged local targets must never become cloud turns.
- Profile edits and credential rotation must not retarget a saved session.
- Queued cancellation and force-stop must not affect a cloud turn.
- Local failures must not trigger auxiliary cloud calls or replay.
- UI switching and restart must expose unsupported resume rather than hide it.

### Task 1: Isolated native local executor

**Files:** `backends/codex.ts`, `local-models/execution.ts`, `test/local-model-execution.test.ts`, `test/codex-backend.test.ts`.

**Interfaces:** Consumes `LocalConnectionStore.resolve` and `LocalThreadTarget`; produces a main-owned `LocalExecution` service with per-thread backend ownership, exact selection and service capacity.

- [x] Write and observe failing tests for native pinning, auth retry suppression, stale sessions, credential isolation and queued cancellation.
- [x] Implement child-scoped configuration and session ownership using the existing Codex RPC path.
- [x] Run focused native and connection regressions; preserve RED and GREEN receipts.

### Task 2: Thread admission and local policy

**Files:** `shared/types.ts`, `engine/runner.ts`, `main/index.ts`, `test/runner-local-models.test.ts`.

**Interfaces:** Consumes `LocalExecution`; adds validated `Thread.localTarget` and effective context, and main-owned execution dispatch.

- [x] Write and observe failing runner tests for no cloud dispatch, Auto/Jev/follow-up/title/fallback suppression, invalid target refusal and local force-stop.
- [x] Implement main admission, persistence and target switching while retaining existing transcript and native approval paths.
- [x] Run runner and cloud-account regressions.

### Task 3: Usable local connection selection and evidence

**Files:** renderer thread controls, focused Electron journey, `docs/local-models.md`, `docs/status.md`, dated review receipt.

**Interfaces:** Consumes `local-models:command` and validated thread updates; presents endpoint/model/context and current selection.

- [x] Add a failing Electron journey for connection setup, explicit Strata selection and safe target switching.
- [x] Implement accessible controls with truthful capability limits and visible errors.
- [x] Run build, unit, typecheck and E2E; review the full diff and record all limitations before signed delivery.

The implementation steps and review fix pass are complete. Verification remains non-green: the final root unit command timed out in the unchanged browser upload test, and real Strata inference is blocked by asset filesystem access. The dated receipt is the continuation ledger; do not infer delivery acceptance from checked execution steps.
