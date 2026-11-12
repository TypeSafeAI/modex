# CF-8 Retention Reproduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the already-reviewed historical/current retention measurements reproducible from an owned fresh checkout without private paths, weakening assertions or changing application behavior.

**Architecture:** Keep the existing three-replicate, 63-open history and 21-stream log workloads and their natural/forced-GC boundaries. A local-only CLI prepares byte-verified source exports at explicit full Git revisions, builds them with the driver's common pinned dependencies, generates the existing-harness driver entry points and writes exclusive durable receipts. Preparation completes before any measurement starts; failures preserve the original logs and inputs without automatic retries.

**Tech Stack:** Node built-ins, pinned pnpm, existing Playwright/Electron fixtures; no new dependencies.

**Spec:** #281's reproducible performance/capture acceptance criterion and the exact workload/limits in `docs/reviews/2026-11-12-cf8-retention.md` on pending PR #507; archived first-pass history/log drivers remain the reference input. This tooling slice cannot complete the combined visual/native/human criterion by itself.

## Global Constraints

- Three fresh-app replicates per workload/source; three 200-turn/1,400-item histories, three warm opens, 63 measured opens; one warm log stream and 21 measured streams, each 48 deltas and 3 MiB logical output.
- No new timing, memory-ceiling, improvement, leak-freedom, provider, release or acceptance claims. The historical source is rebuilt with common current dependencies; it is not a historical shipped binary.
- Require explicit full source revisions, preserve exact build/source/runtime identities, validate source and build bytes before every app launch, keep output exclusive and retain first failures.
- No real model use, installs/downloads, network-isolation changes, feature activation, global CLI settings or installed-app replacement. All launches use existing private synthetic fixtures.
- Scratch exports/generated drivers stay under owned `apps/desktop/.probes/`; durable requested output is private and retained. Never overwrite an existing output or remove unknown data.

## Review Focus

- Existing/symlinked output paths must be refused without changing their contents.
- Invalid source revisions or changed common core dependencies must fail before any build or app launch.
- Tampered source/build files and traversal/symlink manifest entries must fail verification.
- Interrupted preparation and failed measurement must preserve the first failure and cannot silently advance to the next source/workload.
- A source export must never be described as the driver's Git HEAD or as a historically installed release.

## Task 1: Portable preparation, guarded workloads and reproduction receipt

**Files:** Create `scripts/cf8-retention.mjs`, `scripts/lib/cf8-retention.mjs`, `scripts/test/cf8-retention.test.mjs`, and `apps/desktop/bench/retention/*`; update the CF-8 review/status documentation in the same delivery PR.

**Interfaces:** CLI `--output <new-private-directory> --baseline <full-sha> --current <full-sha>` prepares both sources and runs all twelve fresh-app cases, serially without retries. `--prepare-only` retains validated build inputs without launching; `--verify <manifest.json>` rechecks retained source/build/dependency identity without executing code; `--help` has no side effects. Per-source manifests record role, source SHA/tree, app version, source/build hashes, common dependency identity and generated-driver identity. Every measurement binds to that manifest and records the actual diagnostic driver revision separately.

- [ ] Write process-level failing tests for absent CLI help, exclusive output/source-identity refusal and offline manifest tamper/traversal/symlink rejection; observe RED before implementing each behavior.
- [ ] Implement strict arguments, exclusive private output/scratch creation, Git source export/hash guards, unchanged common-core/dependency checks and sequential logged desktop builds. No shell-interpolated commands or destructive cleanup.
- [ ] Port the reviewed fixture/history/log code with output/source/support imports parameterized; preserve positive workload/call-count/output assertions, legacy negative control and GC timing. Keep these opt-in benchmark files outside the ordinary E2E test directory.
- [ ] Run focused tests, fresh build/typecheck/full units, then one complete twelve-case historical/current reproduction on the named host. Preserve the first failure and diagnose it before any separately recorded further invocation.
- [ ] Compare portable receipts/workload identity to the original archived runs, inspect all terminal statuses/source guards and obtain independent review of the complete branch. Commit signed, push, qualify and deliver through protection; retain all unmet #281 criteria.

Expected: focused guards pass, full checks pass with exact counts/skips, all twelve benchmark cases return complete observations and app-close outcomes at their manifest-bound sources; failures remain explicit and do not count as passes.

Execution method: native implementation in this session, within the existing goal's authorized verification-tooling scope; no new product decision or activation is made.
