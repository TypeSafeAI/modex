# Local work recovery

The recovery sweep delivered the unfinished permission, privacy, readiness, Space, and
Knowledge changes through separate protected PRs. Original dirty work and verification
artifacts remain preserved unless a guarded retirement receipt records their removal.

## Delivered behavior

| Area | Delivery | Verified boundary |
| --- | --- | --- |
| Additional permissions | [#162](https://github.com/TypeSafeAI/modex/pull/162) | Installed Codex 0.162.1 schema and response transport; explicit approval grants the displayed profile for the turn, while denial and malformed profiles grant nothing. |
| Streamer Mode | [#169](https://github.com/TypeSafeAI/modex/pull/169) | Display masking preserves original edit, persistence, clipboard, callback, and CLI values. Only embedded Browser, Knowledge, and Canvas panes are covered; the workspace stays usable. |
| Window and test readiness | [#167](https://github.com/TypeSafeAI/modex/pull/167), [#189](https://github.com/TypeSafeAI/modex/pull/189) | Native visibility, renderer dimensions, project reads, and iPhone navigation wait for observed readiness, with explicit failure bounds. |
| Space and Knowledge | [#170](https://github.com/TypeSafeAI/modex/pull/170), [#175](https://github.com/TypeSafeAI/modex/pull/175) | Focus recovery, embedded-page lifecycle, and retained Knowledge fixes; historical Space verification is recorded separately in [#165](https://github.com/TypeSafeAI/modex/pull/165). |
| Update recovery and approvals | [#181](https://github.com/TypeSafeAI/modex/pull/181), [#185](https://github.com/TypeSafeAI/modex/pull/185) | Durable drafts, attachment ownership, pending-send recovery, and approval guards; [local updater acceptance](2026-10-12-updater-local-acceptance.md) and [approval verification](2026-10-12-approval-recovery.md) retain their limits. |
| Release and worktree follow-ups | [#186](https://github.com/TypeSafeAI/modex/pull/186), [#187](https://github.com/TypeSafeAI/modex/pull/187), [#188](https://github.com/TypeSafeAI/modex/pull/188) | Installer bytes tied to native receipts, historical beta status, and exact squash-tree delivery proof. |

Permission checks used the installed protocol and a controlled transport. They do not prove
live model behavior or operating-system sandbox enforcement. Privacy coverage includes
streaming text, native selection labels, Markdown editing, comments, terminal parsing, and
embedded-pane visibility. It does not establish arbitrary secret detection or human IME
and VoiceOver acceptance.

## Integrated verification retained from #190

The original version-preparation head was
`350dbf8a09e9b00a3ec9a2c23335fd03c098d8d9`, with tree
`250bdd4bf98fefcf15b6d59c80ee9647a826290b`. It included the actual #186 squash
`3add7ef271299dff1d2d645156033db3da342d2f` without changing the reviewed tree.

Its earlier combined-source gate passed build, workspace typechecks, and 1,405 unit tests
with 15 skips at `6e40b41e7fb75386d9b479f3b3a01bfdbf4df7f4`; all 639 tracked source hashes
held. The version-preparation gate passed the same checks at tree
`7eb1bca734ef6584f166ee51cd937ac2dda81ae3`, with 640 tracked hashes unchanged and all 404
observed owned process identities absent afterward. The later iPhone destination-predicate
and status change left the other 638 files identical and passed Swift parsing and review.
These are historical source checks, not signed packaged acceptance.

The final [push run](https://github.com/TypeSafeAI/modex/actions/runs/38269893137) and
[PR run](https://github.com/TypeSafeAI/modex/actions/runs/38269972479) at that head passed:

- Both macOS jobs: 1,404 unit tests passed, 16 skipped, 274 desktop E2E cases, and seven site
  cases. All six window-lifecycle cases passed.
- Both iPhone jobs: 28 UI tests passed, including paired approval/follow-up and recovery
  from ignored first taps.
- [Native candidates](https://github.com/TypeSafeAI/modex/actions/runs/38269972339): Windows
  had 16 CLI cases and three installed launches; Linux had four CLI cases, seven terminal
  cases, eight package launches, and three KWallet5 launches. All three installer sizes and
  hashes matched their installed receipts. Five small evidence archives were independently
  hashed and their reports inspected; full installer bytes were verified by the native
  evidence owner against the receipts.

Those final CI results include two unchanged retries. The original push iPhone job failed
while waiting for the ignored-first-tap destination; its trace does not establish a product
fault. The original PR macOS job passed 273 of 274 desktop cases and failed when the native
picker test read `update-recovery.json` before it existed. Failure logs remain preserved.
Passing retries do not establish a correction for either original failure.

## Picker persistence readiness

The follow-up corrects the macOS picker test's missing-file race: wait for the recovery
file to exist before reading it. The existing attachment count, unique IDs, file contents,
and reload assertions remain. A delayed-write probe reproduced the original `ENOENT`;
the corrected source waits for creation while permanent absence and malformed JSON still
fail. Application behavior is unchanged.

Fresh build, workspace typechecks, and 1,405 unit tests passed with 15 skips. The picker
case passed three consecutive Electron runs, followed by 274 desktop and seven site cases
with real OpenKnowledge enabled. All 640 tracked source hashes held through those gates;
the source maps, log hashes, and absence of the observed test processes were independently
checked. Only documentation changed when this verified test correction was integrated
with the recovery record.

## Reconciliation with the published release

[#184](https://github.com/TypeSafeAI/modex/pull/184) subsequently delivered desktop 0.0.11,
Companion build 6, website release metadata, and publication records as
`e765c39e79c818d49bc94896db138b41b647fa6e`. It also added the Canvas test's full-view
readiness assertion. #190's version changes are therefore already delivered. Its remaining
integration evidence is retained here without replacing the
[published v0.0.11 ledger](2026-10-12-v0.0.11-release-review.md).

The published tag points to `fb267e728a3208d11645877d5c3574047cad42fd`, before the updater.
Its macOS artifacts and acceptance do not certify the later integrated updater source.
The first updater-enabled version requires manual installation from published v0.0.11;
automatic installation applies to later supported packaged-Mac updates after signed native
acceptance. Windows and Linux updates remain manual.

## Preservation and remaining acceptance

The October 13 07:48 UTC inventory accounts for 43 present worktrees and 56 dispositions. A fresh
comparison of nine original priority/Space trees confirmed unchanged heads, staged and
unstaged patches, and all 187 saved untracked source hashes. Retained owner-held or dirty
trees have explicit dispositions; a missing checkout is not treated as deletion proof.
The absent `ios-sim-keyboard` checkout's retirement remains unverified. Follow the
[guarded worktree procedure](../worktree-hygiene.md) before retiring any retained tree.

Signed native macOS updater scenarios, authenticated Windows/Linux accounts, KWallet6 and
a full graphical Linux session, migration from a published historical build, and physical
iPhone/human VoiceOver acceptance remain separate release or enablement checks. The native
upgrade fixtures used the same source with synthetic `0.0.0` and candidate versions.
Companion build 6 upload and final paired acceptance are separate from desktop source
delivery. This recovery record does not authorize a new tag, installer publication, or
TestFlight upload.
