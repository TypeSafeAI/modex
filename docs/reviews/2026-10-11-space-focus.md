# Space focus recovery — October 11, 2026

Adding a block starts it with `/`. A queued animation-frame callback could collapse
the user's later selection before replacement text arrived, producing `/Second`
instead of `Second`. PR #165's hosted test saved and reopened that incorrect text.
Formatting had a separate deferred selection callback with the same timing risk.

BlockEditor now records one pending focus range and applies it in a layout effect
after the textarea and its value commit. The request is consumed once, including
operations that retain the same block ID. Formatting preserves both selection
endpoints; an external Markdown replacement clears a stale request. Toolbar Code
insertion uses the slash command's initial caret position inside its fences; ordinary
block insertion and duplication still place the caret at the end.

## Verification

Three native Electron regressions failed against the corresponding unchanged product code:

- Hold animation frames, add a block, select all, release the old callback, then type
  `Second`: the textarea contained `/Second` before saving.
- Hold animation frames while formatting `draft` in `draft note`: the selected range
  was `[14, 14]` instead of `[2, 7]`.
- Insert Code from the new toolbar: the caret was `[8, 8]`, after the closing fence,
  instead of `[4, 4]` inside the code body.

The tests assert replacements immediately, retain save/relaunch coverage, and check
that formatting cannot overwrite a subsequent select-all replacement. The toolbar
regression also verifies typing inside intact fences and saving the replacement.
All four focused checks passed, including same-block numbered-list continuation.
Independent source review found no correctness gaps.

After integrating UI candidate `590cb1e` and the landed Companion shutdown fix (#158),
full build and workspace typecheck passed; 470 unit tests passed with one optional
OpenKnowledge skip. All 171 desktop E2E tests passed, including three real Knowledge
integrations, and all seven site tests passed. This verifies that exact integration;
the UI owner's subsequent floating-chat Knowledge visibility change still needs
integration and affected verification before landing.

Failed traces remain under `~/.codex/recovery/modex-20261011/space-focus-red-results/`
and `space-toolbar-red-results/`. Earlier successful baseline runs are retained
separately from this final caret run.

This is automated native input coverage. It does not claim a human keyboard or
VoiceOver acceptance session.
