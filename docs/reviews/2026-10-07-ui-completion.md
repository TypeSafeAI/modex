# UI completion audit

Scope: rebase onto current main; consistent Jev/OpenCoven colors and clean typography;
compact meaningful tool summaries; immediate visibility of running subagents.

Baseline: `79b9aee` (#132), with both hosted desktop and iPhone gates green. #132 added
thread activity counts but did not consume either CLI's subagent events.

## Implemented and inspected

- Claude Agent/Task and Codex collaboration/subagent events create one row per child.
  Background launch receipts are not completion. Child text cannot contaminate the parent
  answer, and child approvals still use the parent's approval flow.
- The sidebar exposes active agents independently of project expansion/search. Selecting
  a row opens its parent; the activity rail reopens a hidden sidebar. Unselected active
  threads hydrate from the runner after renderer reconnect.
- Terminal agent states survive idle connection updates. Lost streams and unfinished
  history after a process restart become “Status unavailable,” never false success or
  a resurrected running badge.
- Tool summaries infer command/path/query intent, normalize whitespace, fit one line, and
  expand original arguments/output. Keyboard toggling and full-title tooltips remain.
- Workspace/review/browser controls and status colors use the same theme/font tokens as
  chat/sidebar. Jev and OpenCoven screenshots were visually inspected at 1000×720; the
  prior hardcoded workspace palette and premature summary truncation are gone.
- Hosted CI exposed an existing address-edit race: a delayed loading-page snapshot could
  overwrite the next URL before submission. The field now preserves edits until navigation
  or a tab switch; a controlled delayed snapshot reproduced the failure before the fix.
- A hosted terminal fixture failed before the supervisor reached a stopped state and left
  its worker alive. It now waits for a working shell before freezing the supervisor and
  always tears down after assertions. The five-second timeout and ownership checks remain.

## Verification

- Red/green regressions cover concurrent/background and foreground Claude tasks, Codex
  collaboration/activity states, missing snapshots, child approval routing, idle after
  failure, parent isolation, unknown completion, restart recovery and summary inference.
- Electron E2E covers both palettes, two concurrent agents, progress, thread switching,
  renderer reload, sidebar recovery, individual completion/failure, expandable arguments
  and output, keyboard operation, narrow layout and reduced motion.
- `npm run build`, `npm test` and `npm run typecheck` passed. Unit coverage: 15 core,
  287 desktop, 1 browser bridge, 10 site, and 9 Store client checks.
- `npm run test:e2e` passed: 120 desktop and 7 site checks. The final Codex idle-state
  correction also passed its focused protocol test and the complete build/unit/typecheck
  gates. Hosted desktop and iPhone results and the merge receipt are recorded in the PR.

These are protocol-fixture and real Electron integration checks. They do not claim a
new paid live-model turn, VoiceOver acceptance, a new published binary, or Apple approval.
Visibility depends on lifecycle events emitted by the selected CLI during the parent turn.

Protocol sources: installed `codex app-server generate-json-schema` (ServerNotification),
and [Claude task lifecycle reference](https://code.claude.com/docs/en/agent-sdk/typescript#sdktaskstartedmessage).
Native mobile retains its existing system typography and Jev palette; the Mac Store client
loads the shared desktop renderer.
