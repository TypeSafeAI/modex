# Modex screenshot protocol

The existing [approval-card image](../screenshots/01-thread-approval.png) is a checked-in screenshot, not new evidence from this documentation change. Keep its original provenance; do not relabel it as a capture of the latest build.

For fresh captures, use the README's offline screenshot path from an isolated worktree:

```sh
npm run build
npm run screenshot -w @modex/desktop -- --screenshot=/tmp/modex-shots --demo-answer=yes
```

This is an explicit reproduction command, not a claim it was run here. It seeds a throwaway demonstration rather than requiring a CLI login. Never change an ordinary project to full-access mode or launch live coding turns for marketing imagery.

Capture an overview, an approval before it is accepted, and the Changes panel after the synthetic demonstration. Include the source commit, command, operating system, viewport, theme, fixture, and offline mode in the capture record. Review repository paths, user names, notifications, and terminal output for private information before publishing.

Follow the [shared evidence protocol](https://github.com/TypeSafeAI/.github/blob/main/docs/discovery/SCREENSHOTS.md). The editorial card in this directory is not a screenshot; it must not be used to imply that any command executed or approval was granted.

## 2026-10-03 graphite interface capture

The [approval](../screenshots/04-graphite-approval.png) and
[completed turn](../screenshots/05-graphite-complete.png) images were captured from source commit
`4490946704426b5aa342129f8ac85ddadf503a0b` on macOS 26.7.1. The window was 1380 × 880 CSS
pixels (2760 × 1760 on a 2× display), using the dark theme and the isolated `demo-repo` fixture.
The scripted mock backend and built-in heuristic ran without a model login, TypeSafe key, or network
judge. Capture command:

```sh
npm run screenshot -w @modex/desktop -- --screenshot=/tmp/modex-visual-refinement-final --demo-answer=yes
```

The approval image shows the request before it was answered; the completed image shows the scripted
answer and resulting diff. The temporary project contains only demonstration files.
