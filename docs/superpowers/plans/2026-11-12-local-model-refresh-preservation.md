# Local-model refresh preservation implementation plan

> Execute inline with the existing verification and independent-review workflow.

**Goal:** Make #381's cross-thread and connection-revision preservation evidence reproducible in the canonical Electron suite, including text selection.

**Spec:** `docs/design/local-models-settings.md` and #381 S2/AC3. Product admission, compatibility testing, paired provenance, real models and human acceptance retain their independent requirements.

**Architecture:** Keep production code unchanged unless a meaningful regression demonstrates a defect. Promote two reviewed temporary-home characterizations into canonical E2E files and a guarded observer entry point that reuses the existing scripted LocalExecution workflow. Observers call original methods and retain their results. Metadata servers permit only the existing Ollama metadata paths; tests request no coding turns.

## Task 1: Reproducible preservation coverage

- [x] Start an owned helper worktree from protected main `bf497f72b07b2c283a90b5aaa7dfa84f57e3cf39`; retain the finished worktree's recovery bundle and evidence before releasing it.
- [x] Promote the reviewed cross-thread and connection-revision cases into `apps/desktop/e2e/local-model-preservation.spec.ts` and `local-model-profile-revision.spec.ts`; make receipts portable through Playwright output and attachments.
- [x] Add `e2e/fixtures/local-model-preservation.mjs`, guarded to disposable scripted homes, with observer-only coding/discovery counters and exact-request stale-completion binding.
- [x] Run targeted cases with literal selection-range assertions for query, composer and unsaved profile fields. Preserve first failures; repair production only if evidence establishes a defect.
- [x] Reconcile #502 delivery, dated receipts and status. Clarify existing optional LM-8 scope without changing requirements or approval gates.
- [x] Run root build/typecheck/units and full E2E, inspect relevant captures, and independently review the final source and qualification evidence.
- [ ] Sign, push, open a PR, satisfy hosted checks and use the protected queue. Verify actual merged main before advancing any complete criterion.

## Review focus

- Separate direct-IPC setup from ordinary caller refresh; retain the first setup failure without claiming a product regression repair.
- Bind stale completion to the exact second held request, excluding earlier cancellation results.
- Record cancellation versus delivered late bodies explicitly.
- Preserve raw multiline text, image bytes, exact opaque IDs, model target/revision and text selection.
- Keep fixture admission, test encryption, sampled counters and human/native acceptance limits explicit.
