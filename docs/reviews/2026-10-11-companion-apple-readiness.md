# Companion networking and Apple readiness

Execution ledger for the 2026-10-11 brief. The goal remains active until engineering is
delivered and acceptance is evidenced. Hardware and Apple gates must remain explicit.

## Current inventory

- Main advanced to `fa4e665` through protected PR #167; reviewed PR #158 / #167 stack `958253f` is integrated
  locally pending final verification and signed commit. Issue [#109](https://github.com/TypeSafeAI/modex/issues/109) open.
- Dedicated worktree/branch: `companion-readiness`, owned by session
  `01a12992-ca4f-7953-bf53-2e8875f2cf15`. Other worktrees are preserved.
- [#158](https://github.com/TypeSafeAI/modex/pull/158), reviewed head `958253f`:
  includes the CI synchronization prerequisite [#167](https://github.com/TypeSafeAI/modex/pull/167).
  Both are integrated locally; #167 landed after both required macOS checks passed.
  #158 and subsequent queue landings remain coordinated by their owner; no protection is bypassed.
- [#157](https://github.com/TypeSafeAI/modex/pull/157), head `5d79f2e`:
  attachment implementation in another session. Store limitations must remain explicit.
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
| Store parity | Matrix covering real host transport and every feature in mac-app-store.md | Matrix complete; recovery/parity patch reviewed, build/typecheck/481 unit passes plus one expected skip, 168 desktop and seven site UI passes; delivery pending |
| Store discovery/launch/consent/reconnection | Compatible same-team signed host, native confirmation, cancellation/denial, revoked credentials | Native validator13/13; signed running discovery and code comparison/denial passed. Launch, cancellation, reconnect and revocation pending |
| Real CLI and fresh macOS user | Signed sandboxed Store client exercising both CLIs and new-user lifecycle | Real signed Store Codex and Claude turns and isolated-runtime-name credential persistence passed. User confirmed no fresh account available |
| Apple status and metadata | Current ASC records; screenshots, description, keywords, support URL, review evidence | Readback complete; both beta reviews approved. Draft metadata and three screenshots prepared; production drafts incomplete |
| Delivery | Build + unit + UI checks before signed commit/push; review and protected squash merge | Signed `2d05556` pushed as [PR #166](https://github.com/TypeSafeAI/modex/pull/166); integrated build, 477 unit passes plus one expected skip, typecheck, 167 desktop and seven site UI passes; signed follow-up, protected CI and merge pending |

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

Store recovery implementation is isolated in the `store-recovery` worktree, based on
`4945b33`. The next patch refreshes installed-host discovery, reports identity/protocol
recovery, enforces the Modex account exclusion, and connects native workspace menu actions.
Read-only CLI preflight found authenticated Claude Code 2.1.296 and Codex 0.162.1; this is
not real Store coding-turn evidence. Val confirmed no fresh macOS test account is available.
Current-account signed checks must use a separate client container and disposable host
workspace; they cannot establish fresh-user acceptance or safely exercise a default-data
host launch.

## Next action

Required integrated verification passed: build, 477 unit tests with one expected skip,
typecheck, and all 167 desktop UI tests. Another session briefly occupied site port 5187;
after it exited independently, all seven unchanged site tests passed. Receipts are
`integrated-{build,unit,typecheck,e2e}.log` and `integrated-site-rerun.log` in the private
acceptance artifacts. Sign, push and land PR #166 after the prerequisite protected PRs
and checks pass. Native
38/38 and the final scoped paired physical flow passed; the final fresh-consent trace
reached its request and timed out after 75.63 seconds without a prompt. Store recovery
passed review, full unit verification, and its complete UI rerun after an ENOSPC interruption.
Continue [signed current-account acceptance](2026-10-11-store-signed-acceptance.md)
and deliver that patch. Do not close #109 based on single-LAN or simulator evidence.
