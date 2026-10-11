# Space focus recovery — October 11, 2026

Adding a block starts it with `/`. A queued animation-frame callback could collapse
the user's later selection before replacement text arrived, producing `/Second`
instead of `Second`. PR #165's hosted test saved and reopened that incorrect text.
Formatting had a separate deferred selection callback with the same timing risk.

BlockEditor now records one pending focus range and applies it in a layout effect
after the textarea and its value commit. The request is consumed once, including
operations that retain the same block ID. Formatting preserves both selection
endpoints; an external Markdown replacement clears a stale request.

## Verification

Two native Electron regressions failed against unchanged product code:

- Hold animation frames, add a block, select all, release the old callback, then type
  `Second`: the textarea contained `/Second` before saving.
- Hold animation frames while formatting `draft` in `draft note`: the selected range
  was `[14, 14]` instead of `[2, 7]`.

The tests assert the replacement immediately, retain save/relaunch coverage, and
check that formatting cannot overwrite a subsequent select-all replacement.
All three focused checks passed after the fix, including same-block numbered-list
continuation. Independent source review found no correctness gaps. Full build and
workspace typecheck passed; 468 unit tests passed with one optional OpenKnowledge
skip. All 167 desktop E2E tests passed, including three real Knowledge integrations,
and all seven site tests passed. The failed traces are retained
under `~/.codex/recovery/modex-20261011/space-focus-red-results/`.

This is automated native input coverage. It does not claim a human keyboard or
VoiceOver acceptance session.
