# Model picker search implementation plan

> For agentic workers: use superpowers:executing-plans to implement this plan task by task.

**Goal:** Complete the existing #381 search requirement while preserving exact identities, draft state and keyboard editing during metadata refresh.

**Architecture:** Extend the current ModelMenu and its existing connection groups. Search is renderer-only view state: case-insensitive matching never changes IDs or selection. The shared Menu accepts an optional initial focus element and preserves text editing keys; arrow keys still reach menu choices. No producer/admission changes.

**Tech stack:** Existing React/TypeScript, Electron and Playwright; pinned pnpm 10.34.5.

**Spec:** `docs/design/local-models-settings.md`, model-menu and tests sections, plus #381 S2 and AC3. This plan implements their search/preservation portion; it does not discharge the full settings/native/paired acceptance matrix.

## Constraints and review focus

- Preserve exact model IDs, connection revisions, existing draft/attachment ownership and main-owned admission.
- Never initiate inference while filtering; metadata refresh remains the existing read-only operation.
- Keep manual IDs after failed discovery and keep connection health distinct from qualification.
- Search updates must not remount the input or steal focus when discovery completes.
- Home/End and horizontal arrows edit text; ArrowDown/ArrowUp reach the first/last available menu choice. Escape restores trigger focus. Preserve existing behavior for menus without a search input.

## Task 1: Search and keyboard/preservation regression

- [x] Add `apps/desktop/e2e/model-search.spec.ts` using actual Electron/main/IPC with a held metadata response. Assert connection/ID filtering, exact manual IDs, unchanged draft/target, input value/focus through response completion, no-match feedback, text cursor keys, navigation and Escape.
- [x] Run the cases against unchanged production source and retain the first missing-search failures.
- [x] Extend `ModelMenu.tsx` with local query state, input and filtered cloud/local groups; clear query on closure. Keep management and cloud-return controls available.
- [x] Extend `components/ui/Menu.tsx` with optional initial input focus and text-editing-aware key handling. Add theme-token styling in `styles.css`.
- [ ] Run focused search and existing local-model/menu suites, inspect actual Electron captures, then root build/typecheck/units and full E2E. Review before signed commit/push and protected delivery.
- [x] Reconcile the delivered #500 queue evidence and #380 S5 count in `docs/status.md` and dated receipts; record search's actual verification and limits separately.
