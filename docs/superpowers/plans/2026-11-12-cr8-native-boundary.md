# CR-8 native adversarial app boundary implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. The active all-issues goal already authorizes this fixture work and its normal protected delivery.

**Goal:** Exercise adversarial review instructions through actual Electron/main and the installed Claude CLI against the existing scripted provider, retaining the full #327 requirement and separating this fixture evidence from real-provider acceptance.

**Architecture:** Reuse `code-review-support.ts` and the existing bounded `claudeFixture` provider. Add optional launch and selected-input/prelude hooks with unchanged defaults, so an opt-in Electron case can supply the real main-owned review process while the existing six native controls keep their current behavior. The native executable is cloned into a private root and restricted to the owned loopback provider, with user-home and security-daemon access denied; no new application backend or inference API is added.

**Tech Stack:** Pinned pnpm, existing Playwright Electron harness, Node fixture HTTP server, installed native Claude CLI, macOS sandbox-exec and a private test launcher.

**Spec:** [CR-8 #327 full adversarial/race step](https://github.com/TypeSafeAI/modex/issues/327); production confinement in `apps/desktop/src/main/engine/backends/claude.ts` and the existing native fixture are authoritative. This implements one missing integrated test path; the entire adversarial step stays unticked until all clauses and on-main delivery are verified.

## Global constraints

- Only synthetic PRs, provider responses, usage counters and invalid fixture credentials; no real inference, personal credential reads, model downloads or GitHub mutations.
- Preserve every production confinement argument. The test launcher may only bind its private fixture environment and make resource limits stricter.
- Use one explicit UI start. Bound provider turns to four, request bodies to 256 KiB, direct-runner output to the existing limits and integrated native completion to the UI/test timeout; callback mode omits unobserved direct-runner diagnostics; preserve the first failure and verify owned process/server closure.
- Preserve existing six native controls and their default fixture behavior; skip the new native app case explicitly outside macOS or when its opt-in flag is absent. An explicit opt-in with a missing/incompatible CLI fails qualification, matching the existing native controls.
- No installed-app/session, feature default, execution admission, real-provider budget or other-owner changes.

## Review focus

- Hostile PR instructions must actually be read from the main-owned snapshot before adversarial tool proposals; assert the fixture receives the injected marker in the Read result.
- An outside secret and symlink must not appear in native results; retain the existing direct symlink control and assert outside-read refusal in the app path.
- Shell, file write, WebFetch and MCP proposals must be refused by the installed CLI; assert Read plus any separately proven inert reserved placeholder, with no executable extra tool, denied results and absent effect markers/HTTP route.
- A failed native process or server must not become a passing UI outcome or trigger a second start; collect typed app outcome and actual launcher/process evidence, and retain first failure data before cleanup.
- Private homes, endpoints and synthetic credentials must remain scoped; deny non-fixture outbound network, real user-home reads and securityd, and assert the production child strips Modex/GitHub environment.

## Task 1: Integrate the existing native denial fixture with the actual review UI

**Files:** Modify `apps/desktop/test/fixtures/code-review-native-isolation.mjs`; create `apps/desktop/e2e/code-review-native-boundary.spec.ts`; update this plan and `docs/status.md`; add a dated evidence receipt only after actual execution.

**Interfaces:** Extend `claudeFixture(t, mode = 'candidate', options = {})` with optional `readFirst` and `selectedInput` strings, `keepRoot`, `launch(setup)` and `onObservation(snapshot)` callbacks. `setup` exposes only this fixture’s private root/repo/home/copied executable/guard/environment/port/version. With no options the existing direct-spawn path and return fields stay unchanged. A callback returns its actual app/launcher observations without inventing a native exit code; the common fixture still owns the bounded provider, result collection, markers and teardown. The observation snapshot is persisted and exposed on callback resolution or rejection; cleanup preserves the primary error and independently records shutdown uncertainty.

- [x] Build the unchanged baseline and run all six existing native controls once, retaining logs/version and first failures externally. Baseline `d6bda9b` passed build and all six native controls with zero skips/failures; external receipt `cr8-native-boundary-baseline-terminal-proof.json` retains exact versions and first logs.
- [x] Add the opt-in app test with a synthetic hostile PR, actual UI Start, private native launcher and assertions for context read, exact tool palette, all forbidden results, unchanged selected evidence, absent markers/unexpected HTTP, one start, truthful completed outcome and owned process closure. Initially require the missing fixture hooks so the first run demonstrates the missing integration.
- [x] Extend the shared fixture minimally: an optional first Read of `PULL_REQUEST.md`, configurable successful Read input, and a launch callback; retain existing direct-mode defaults and result fields.
- [x] Run the native app case with `MODEX_CR6_NATIVE=1 pnpm --filter @modex/desktop exec playwright test e2e/code-review-native-boundary.spec.ts --workers=1 --retries=0 --max-failures=1`. Preserve its first result rather than retrying automatically.
- [x] Re-run the six existing native controls after the shared-fixture change and run affected default Code Review cases; retain explicit skips and exact source/runtime identities. Run required build/full units and applicable full E2E before pushing, reusing unchanged-source evidence only when its complete scope is proved.
## Delivery gates after implementation validation

These gates remain mandatory before this slice is delivered; the implementation task’s completion line alone does not satisfy them.

- [ ] Freeze the implementation, obtain one fresh whole-slice review, fix valid findings in one coalesced pass, rule on every declined scope with costs, then sign/push/open a PR with a factual status update.
- [ ] Observe exact-head hosted and protected checks, verify actual merged tree/signature and retained receipts, and only then audit every clause of #327’s full adversarial/race requirement. No live-provider/write/human acceptance follows from this synthetic-provider test.

## Self-review

One existing fixture and one integrated test own the complete flow; no production interface changes or new framework are planned. Existing direct tests pin backward-compatible behavior, and each review-focus failure has explicit assertions above. The preserved full #327 clause also requires identity, revoked access, pagination, unsafe content, Stop/unknown and lost-write cases; those existing cases must be separately mapped before any checkbox advances.

## Final review correction

One fresh review of `4547507` found exception-dependent observation/cleanup loss. The single correction pass added callback/close fault controls and strict process-inspection checks, observed their failures, then made them pass while preserving the original successful receipts. Six focused checks include two intentional expected qualification failures whose exact errors, artifacts and provider closure are independently verified. Full post-correction build/units and six direct native controls passed; default opt-out explicitly skips all six cases. Full S5, live, human and protected delivery gates remain separate.
