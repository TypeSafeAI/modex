# Companion networking and Apple readiness

Execution ledger for the 2026-10-11 brief. The goal remains active until engineering is
delivered and acceptance is evidenced. Hardware and Apple gates must remain explicit.

## Current inventory

- Main advanced through the protected integration queue to `a2f6130` (#152).
  This branch consolidates preserved local `12e03b6` and remote `f049c5d5`, including
  Store recovery from #172, onto that main commit. Conflict resolutions preserve
  account handling, attachment exclusions, modal suspension and display-only Streamer
  Mode behavior. The rebased candidate passed fresh build, typecheck, 726 unit tests,
  228 desktop and seven site UI tests, with OpenKnowledge enabled and no skips.
  Earlier commit and test receipts below are historical.
  Issue [#109](https://github.com/TypeSafeAI/modex/issues/109) remains open.
- Dedicated worktree/branch: `companion-readiness`, owned by session
  `01a12992-ca4f-7953-bf53-2e8875f2cf15`. Other worktrees are preserved.
- [#158](https://github.com/TypeSafeAI/modex/pull/158), reviewed head `958253f`:
  includes the CI synchronization prerequisite [#167](https://github.com/TypeSafeAI/modex/pull/167).
  Both have landed through protection. Subsequent queue landings remain coordinated by
  their owners; no protection is bypassed.
- [#157](https://github.com/TypeSafeAI/modex/pull/157) landed as `5e80b46`, matching the
  reviewed `21784a9` tree; all four hosted checks passed. Store attachments remain excluded.
  Both changes are included through the `a2f6130` rebase base.
- `xcrun devicectl list devices`: paired iPhone 16 Pro Max available. Paired and extended physical acceptance
  flows passed, including the final scoped pairing build; first-use consent remains unaccepted. Mac has one supported IPv4 LAN
  (`en0`); no real secondary LAN present.
- Authenticated App Store Connect GETs at 06:41–06:42 UTC confirmed both latest beta
  reviews approved. [Current Apple receipt](2026-10-11-apple-status.md). No Apple writes
  were made; external submission still requires explicit approval.

## Requirements and proof

| Requirement | Authoritative proof needed | State |
| --- | --- | --- |
| Supported listeners only | Real socket tests and interface selection tests; excluded interface negative probe | Passed for this Mac and tested interface classes |
| Reachable secondary-LAN pairing/discovery | Per-endpoint advertisements and pairing; physical second-network connection | Implemented; real second LAN unavailable |
| Stable unaffected connections and trust | Keep-alive socket identity, same certificate/token across address change | Socket and fingerprint tests passed |
| DHCP/offline/occupied port/shutdown/revocation | Focused lifecycle and in-flight authorization tests | Automated checks passed; physical port recovery/revocation passed |
| Physical iPhone | Pair, relaunch/reconnect, confirm/deny/persist approvals, complete skill descriptions, merged-PR retirement | Paired, extended, deny and final scoped flows passed; fresh-consent trace remains separate |
| Store parity | Matrix covering real host transport and every feature in mac-app-store.md | Audit matrix complete; recovery/parity [PR #172](https://github.com/TypeSafeAI/modex/pull/172) reviewed, build/typecheck/490 unit passes plus one expected skip, 171 desktop and seven site UI passes. Full parity acceptance and delivery remain open |
| Store discovery/launch/consent/reconnection | Compatible same-team signed host, native confirmation, cancellation/denial, revoked credentials | Native validator 13/13; signed running discovery, matching-code Allow/denial, real Claude Stop, same-process draft retention across host restart, and native revocation/credential removal passed. Signed Preview auto-launch connected after user-confirmed Allow; its intended Cancel sequence was not exercised. Signed helper-to-regular-host URL launch and reuse passed with an explicit candidate path. Full welcome Open selection, subsequent pending-consent/Cancel, fresh-user setup, and sleep/wake remain unaccepted |
| Real CLI and fresh macOS user | Signed sandboxed Store client exercising both CLIs and new-user lifecycle | Real signed Store Codex and Claude turns and isolated-runtime-name credential persistence passed. User confirmed no fresh account available |
| Apple status and metadata | Current ASC records; screenshots, description, keywords, support URL, review evidence | Readback complete; both beta reviews approved. Draft metadata and three screenshots prepared; production drafts incomplete |
| Delivery | Build + unit + UI checks before signed commit/push; review and protected squash merge | [PR #166](https://github.com/TypeSafeAI/modex/pull/166) historical source `e6bfeee` passed both hosted checks after build, 477 unit passes plus one expected skip, typecheck, 167 desktop and seven site UI passes. Docs-only head `55b3583` passed hosted iPhone CI; macOS failed on the known Space race fixed by merged PR #170. The earlier integration with main `312a138` passed build, typecheck and 488 unit tests plus one expected skip; 177 desktop and seven site UI tests also passed. All four hosted checks passed for stacked Store head `3d91754`. Final queue integration and protected merges remain pending |

## Execution sequence

1. Implement networking in `companion.ts`, `companion-discovery.ts`, native Pairing/discovery,
   and pairing UI as needed. Use individual bound endpoints; never wildcard listeners.
   Keep shared authorization and certificate identity. Reconcile only changed addresses.
2. Add regression tests before implementation, then run desktop build and focused networking
   tests. Verify native parsing/candidate recovery and paired simulator flow. Run all required
   workspace build/unit/UI checks before commit or push.
3. Deliver networking through protected PR. Record real LAN/physical results separately from
   loopback and simulator tests; #109 cannot be called fully accepted without the second LAN.
4. Complete Store discovery/launch and parity from current code, coordinating #157 limitations.
   Exercise signed client with real CLI and fresh-user acceptance; record exact blockers.
5. Refresh ASC read-only when access exists. Prepare local metadata/screenshots and reviewer
   evidence. Request approval only for the concrete external submission/publication.

## Networking implementation and verification

- Three new socket regressions failed before the change: only one listener advertised,
  an unavailable primary address aborted startup, and shutdown waited on an incomplete TLS
  handshake. The original eleven Companion tests passed at baseline.
- Each selected private address now has an independent HTTPS listener and unique Bonjour
  service name. The pairing UI selects among live endpoints with matching QR/copy values.
  Listener removal invalidates only that listener's pending requests and closes every raw
  socket; stop invalidates all listeners. All endpoints share the original certificate/token.
- Focused verification: 19 socket/lifecycle tests and two Electron pairing tests passed.
  The new selector test first failed because no network selector existed.
- Native discovery: the bounded 16-candidate rotation alternates with the saved address;
  discovery notifications no longer cancel an in-flight request. Three regression tests
  failed before implementation; the full native suite passed 37/37 with no skips. Result:
  `/tmp/modex-ios-discovery-unit/Logs/Test/Test-ModexCompanion-2026.10.11_01-19-28--0500.xcresult`.
- Independent spec and code/security review found no blocking defect. Review identified that
  the pending-bind test stopped before bind began; it now waits at a real socket bind barrier
  before stop/dispose. The strengthened eight-test network suite passed, including an actual
  certificate fingerprint check on the secondary listener.
- PR #158's failed macOS job was the unrelated Knowledge Files-navigation click timeout
  (163 passes, one failure). This branch includes the same raw-socket shutdown protection
  as #158 without changing its worktree or branch.
- User confirmed only the iPhone is available, then unlocked it after Apple's device service
  reported `kAMDMobileImageMounterDeviceLocked`. The acceptance build uses a distinct bundle
  ID and Keychain service so the existing TestFlight installation remains intact.
- Full workspace build, unit suite and typecheck passed. Counts: 15 core, 439 desktop plus
  one bridge, 10 site, nine Store tests; one opt-in OpenKnowledge integration test skipped.
  All 165 Electron UI tests passed with `MODEX_TEST_OPEN_KNOWLEDGE=1`. The site suite's
  first launch failed because another session occupied port 5187. That process ended
  independently; the unchanged site suite then passed all seven tests without intervention.
- Live interface probe at 06:31 UTC: the supported LAN endpoint returned authenticated 200;
  both internal endpoints, nine public IPv6 endpoints and the CGNAT endpoint refused TCP.
  One private IPv6 endpoint timed out, which is weaker negative evidence. No excluded endpoint
  accepted a connection. This is still a single-LAN Mac, not secondary-network acceptance.
- Physical iPhone retry passed its paired flow: Keychain persistence, skill insertion/thread
  creation, approve-once, follow-up, Bonjour recovery to a new port, persisted endpoint and
  revocation through relaunch. First-use pairing failed after Local Network permission was
  granted; the cause is still under investigation and first-use acceptance is not claimed.
  The extended physical test then passed persisted Always allow, YOLO receipts, a complete
  1,777-character skill description, and actual TaskRetirer removal of a disposable worktree
  after REST readback of merged PR #156. The phone retained its finished read-only transcript
  through relaunch. Coding responses were fixture-generated, not live CLI acceptance.
- Simulator LAN+RECONNECT UI suite passed 2/2 with no skips on iPhone 16 Pro/iOS 26.5.
  Durable evidence is under `/Users/buns/Documents/Codex/artifacts/modex-companion-acceptance-2026-10-11/`;
  the raw test results are private because UI diagnostics may include disposable pairing links.
- Required local verification completed before preparing the signed networking commit.
  Protected PR checks and merge remain separate delivery gates.
- Fresh review of signed head `2d05556` approved the implementation subset with no blocking
  quality/security findings. First-use pairing and second-LAN hardware remain acceptance gates.

## Store and Apple preparation

The [Store readiness matrix and metadata packet](2026-10-11-store-readiness.md) records
current discovery/launch implementation, exact parity gaps, attachment PR #157 limitations,
and draft listing text. The [October 11 Apple receipt](2026-10-11-apple-status.md) supersedes
the historical waiting-for-review states: both latest beta reviews are approved. Production
metadata is incomplete, and Companion's production version/platform needs reconciliation.
External submission/publication is not authorized by this brief.

Store recovery from [PR #172](https://github.com/TypeSafeAI/modex/pull/172) merged into
`companion-readiness` as `f049c5d5` and is included in the rebased #166 candidate. It refreshes
installed-host discovery, reports identity/protocol recovery, enforces the Modex account
exclusion, and connects native workspace menu actions. Its integrated build, typecheck,
490 unit tests and 171 desktop plus seven site tests passed before the signed push.

The [signed current-account receipt](2026-10-11-store-signed-acceptance.md) records real
Claude Code 2.1.296 and Codex 0.162.1 turns, Stop, encrypted-access relaunch, native approval
and denial, same-process draft retention across host restart, and native revocation. All
disposable grants were revoked through the native menu, the controlled candidate's saved
access removed, and owned candidate processes stopped. It also preserves the earlier interrupted runs and the
UI-helper default-profile fallback caveat. Val confirmed no fresh macOS account is available;
these checks do not prove fresh-user setup, installed-host auto-launch, or full Store parity.

## Verification history

Historical source `e6bfeee` passed build, 477 unit tests with one expected skip,
typecheck, and all 167 desktop UI tests. Another session briefly occupied site port 5187;
after it exited independently, all seven unchanged site tests passed. Receipts are
`integrated-{build,unit,typecheck,e2e}.log` and `integrated-site-rerun.log` in the private
acceptance artifacts. Signed local checkpoint `dcbc10d` includes main `312a138`
(#170 and #169 have landed), preserving the Companion selector, raw-socket shutdown and
Streamer Mode display handling. This working tree passed build, typecheck and 488 unit
tests plus one expected skip; logs are `main-312-{build,unit,typecheck}.log` under
`apps/desktop/.probes/`. All 177 desktop and seven site UI tests passed; native test processes and site port 5187 were clear afterward. These are historical
receipts. PR #152 subsequently landed as `a2f6130`; the current rebase combines that actual
main with the preserved local `12e03b6` and remote `f049c5d5` changes. PR #172 is already
closed and must not be retargeted. Its Store recovery and inert guards remain in #166.
The combined candidate requires fresh verification before protected delivery.

The later docs-only head `55b3583` passed hosted iPhone CI. Its macOS build and unit
checks passed, but the desktop suite had 166 passes and one Space failure: replacing
the initial `/` in a new block persisted `/Second` instead of `Second`. The queued
focus callback changes selection after the edit begins. PR #170 already contains the
fix and a deterministic regression for this exact race; it is included in the local integration
instead of retrying the unchanged head. The job log, full artifact and extracted trace
are preserved as `ci-55b3583-*` in the private acceptance artifacts. All four of PR #172's
hosted push/pull-request checks passed for macOS and iPhone.

Native 38/38 and the final scoped paired physical flow passed; the final fresh-consent
trace reached its request and timed out after 75.63 seconds without a prompt. No further
phone runs are scheduled. The separate auto-launch guard found that the exact sandboxed
Store/helper selected installed Modex instead of the isolated adjacent artifact. It
stopped before GUI Connect or host launch; both default profile metadata snapshots and
the original ciphertext were unchanged. The subsequent file-read diagnostic found the
Documents fixture inaccessible. An unchanged copy in Applications passed read and exact
selection checks from both the original and relocated Store. The later Open action
launched that Preview, and the user confirmed clicking Allow before the pending dialog
could be captured. Native revocation and complete cleanup passed. The intended Cancel
sequence was not exercised. Apple documents that App Sandbox ignores launch arguments;
the Preview's automatic service startup masks regular Modex's reliance on that flag.
The supported URL handoff is implemented and independently reviewed. Its regression failed
before implementation and passed afterward; 13 focused activation, native capability and
Host trust tests and three focused Electron UI tests passed. The UI regression injects
the application event and does not prove signed operating-system delivery. The complete integration passed build/typecheck, 488 unit tests plus one expected skip,
and 177 desktop plus seven site UI tests. The exact signed sandbox helper subsequently
launched regular Modex through the URL without flags and reused its PID, port, and
certificate with zero grants. This explicit-path check does not cover welcome Open
selection. The later GUI Connect acquired a grant before native prompt capture, stopping
the Cancel check; attribution is awaiting Val's response. Native revocation and complete
cleanup passed, and the owned application copies were unregistered and retired. Keep
first-use consent, second-LAN hardware,
fresh-user setup and remaining Store scenarios explicit. Do not close #109 based on
single-LAN or simulator evidence, or perform Apple writes without separate approval.


## Native fixture regression during rebase

The private `Pending` test helper previously discarded results delivered before its
reader registered. Three deterministic native regression methods cover early and late
success/error settlement and cancellation before registration. Against the old helper,
one method passed and two failed, including cleanup value 99 replacing the expected 42.
The original failing source and xcresult are preserved. This proves the fixture defect;
it does not establish the cause of the earlier hosted pairing expectation timeout.

The repair retains the first explicit settlement and ignores later resolutions. A reader
cancelled before registration finishes with cancellation rather than leaving a suspended
continuation. After applying that repair, all 41 native unit tests passed with zero skips
on an isolated iPhone 16 Pro simulator running iOS 26.5. The failing run completed in
153.499 seconds and the full passing run in 41.292 seconds; neither timed out. The exact
repaired test-source SHA-256 is `94ee0d5010ce705fe199bd30e23f55744a40294dd0575daade7d97ae8dd3b0e6`.
Owned test processes exited and the isolated simulator was shut down before releasing the
shared test window. These unit tests do not add physical-phone or fresh-consent acceptance.

## Store modal regressions during rebase

Review of the combined Store recovery and browser-tools code found two missing guards:
while recovery made the preserved workspace inert, the hidden browser-tools dialog still
captured Tab and Escape; native Workspace menu commands also bypassed that dialog's
shortcut suspension. The new UI checks reproduced both failures: focus did not advance
to **Forget access and reconnect**, and **New tab** increased the tab count behind the
dialog. After adding the inert-ancestor and browser-tools guards, both tests passed
(10.3 seconds) following a successful workspace build. The recovery case also proves
Shift-Tab, preserved Escape state, explicit retry, restored overlay and retained draft;
the menu case covers both **New tab** and **Hide workspace**. These are automated Electron
checks, separate from native signed Store acceptance.

## Verified rebase onto main `a2f6130`

The consolidated candidate preserves the original local `12e03b6` and pushed
`f049c5d5` work, including Store recovery from #172. Reviewed conflict resolutions
retain account commands, Store attachment exclusions, modal suspension and display-only
Streamer Mode. Source and package hashes remained unchanged throughout the final gate.

- `npm run build`: passed.
- `npm test` with OpenKnowledge enabled: 726 passed, zero failures or skips.
- `npm run typecheck`: passed.
- `npm run test:e2e` with OpenKnowledge enabled: all 228 desktop and seven site tests passed.
- Native unit suite: all 41 passed; native source remained unchanged afterward.
- Independent review of the final browser-tools guards: no remaining findings.

The complete desktop gate took 569.741 seconds. Its owned processes exited and ports
3100/5187 were clear. These checks establish the combined source's local automated
results; they do not close the physical, signed fresh-user or Apple publication gates
listed above. Protected merge and hosted checks remain delivery steps.


## Verified integration with main `edf52fc`

Published head `86d42ad939cc164817774858c3779f9ced948ac4` and the earlier recovery
refs were preserved before integrating frozen #173 head `e18f1c1`. The three
conflict resolutions retain the stricter owned-PID fixture validation, both Store
account-command handling and Canvas rejection, and both documentation streams.
Independent coordinator and renderer/Store reviews found no remaining findings.
Unmerged #174, #176 and #177 work was not absorbed.

The prospective candidate tree was `a89d01e17dae5b58c8426e9fba128c3846f98b75`.
After #173 merged as `edf52fc7241e8f2ad7375870a25e19d80e04a464`, its tree exactly
matched the frozen upstream. Only after the desktop gate and process cleanup did
this session replace its own uncommitted prospective merge with the actual-main
merge. The whole candidate tree and all 525 tracked file hashes remained identical;
published #166 history was not rewritten.

- `npm ci`, `npm run build` and all workspace typechecks passed.
- `npm test` with `MODEX_TEST_OPEN_KNOWLEDGE=1`: 834 passed, zero failed, 12 native
  Windows npm/CLI/PTY cases skipped on macOS. Those skips are not Windows acceptance.
- `npm run test:e2e` with OpenKnowledge enabled: all 241 desktop and seven site tests
  passed, including the real Knowledge install/edit/privacy/shutdown case. No skips.
- Fresh isolated iPhone 16 Pro / iOS 26.5 native gate: all 41 unit and 28 paired/demo
  UI tests passed with zero failures or skips. The paired flow took 82.163 seconds.
  Both xcresult summaries identify disposable device
  `B6D1811F-DA53-4E72-9351-D4DFFD718641`.

The desktop gate completed in 602.952 seconds and the native gate in 264.015 seconds.
All 525 tracked hashes stayed fixed through both gates and actual-main reconciliation.
This section and `docs/status.md` are the only subsequent verification-record edits.
Owned wrapper, fixture and test processes exited; ports 3100/5187 were clear. The
owned simulator is shut down and retained, the pairing fixture was removed by its
harness, and the UI xcresult was copied with all 114 file hashes verified. The shared
runtime slot was explicitly released.

Private local evidence is retained under `.codex/rebase-verification/prospective-e18/`
(desktop gate, source freeze, conflict review and actual-main equivalence) and
`.codex/rebase-verification/actual-edf-native/` (native logs, both xcresults/summaries,
verified copy and cleanup release). Recovery refs begin
`refs/codex/companion-readiness/20261011T213537Z/`.

Three earlier upstream CI failures remain separate evidence: #175's optional push
run did not show `pairing-link-input` after tapping Pair (job `114571241637`, artifact
`11715456419`); an earlier #173 run exhausted the keyboard-focus helper's deadline
at `new-thread-input`; and #173's optional PR run could not find a ready **Forget
paired Mac…** button (job `114578262026`, artifact `11717276427`). They did not
reproduce in this fresh local flow. Their causes and any common relationship remain
undetermined; no new fix for those failures is claimed.

Fresh exact-head hosted checks and protected PR #166 landing remain delivery steps.
The second physical LAN, first-use consent, fresh macOS user, complete signed welcome
Open/Cancel path, sleep/wake, migration and other Store acceptance limits above remain
open. No Apple metadata, submission, build or release was changed. Preserve this
worktree and its evidence until delivery and a separate guarded retirement review.
