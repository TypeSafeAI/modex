# Slim panels and Knowledge disclosure

Implementation in `slim-panels`, based on `main` at `8fc3506`. The Knowledge maintenance
dependency landed in PR #150. The later iOS-only test update from PR #153 was integrated;
all verified desktop/site/core input files remained byte-for-byte unchanged.
Release packaging and installation are outside this change.

- Knowledge uses a single 36px toolbar. Agent maintenance expands below it.
- Sidebar and workspace default to 240px and 360px. Both support pointer dragging,
  arrow keys, Shift for larger steps, Home/End, and double-click/Enter to reset.
- Widths survive relaunch and panel toggles. Space shares the sidebar preference.
  Smaller windows clamp the displayed widths without discarding saved preferences;
  at 900px, chat retains at least 350px.
- Native guests hide during dragging and return at the resized bounds.
- The pinned OpenKnowledge 0.83.2 Properties disclosure spans its full header and
  starts closed when there is no saved choice. It collapses nested fields and Add
  controls together, retaining the companion's own persistence and keyboard handling.

## Verification

- `npm run typecheck` and `npm run build`: passed across workspaces.
- `npm test`: 466 passed, one existing opt-in test skipped.
- Fresh pre-commit desktop e2e with `MODEX_TEST_OPEN_KNOWLEDGE=1`: all 163 passed
  in one run. Website e2e: all seven passed in the same verification command.
- Earlier implementation runs exposed four outdated geometry assertions (corrected)
  and one intermittent agent-to-Knowledge viewport-timing failure. That navigation
  test subsequently passed twice in isolation and in the clean full pre-commit run.
- Real companion acceptance covered Properties expand/collapse/reload, native guest
  hiding during a drag, editing, all three themes, privacy, and server shutdown.
- Independent read-only code review: no actionable findings.
- `git diff --check`: passed. No manual VoiceOver acceptance was performed.

Screenshots are kept in the worktree's ignored `apps/desktop/.probes/slim-panels/`:
`knowledge-slim.png` and `properties-collapsed.png`.
