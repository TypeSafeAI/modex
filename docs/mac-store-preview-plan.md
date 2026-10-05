# Mac App Store preview execution ledger

Val requested a runnable desktop Store preview on 2026-10-05, following approval of the
separate signed-host direction. Reuse the existing desktop React interface and CLI-owned
engine. The iPhone-on-Mac Companion is not this desktop target.

## Implementation

- [x] Add a dedicated, opt-in loopback HTTPS host transport over the existing desktop command handlers.
- [x] Pair each desktop installation with a short-lived, single-use host invitation; persist hashed grants and support revocation.
- [x] Add a client that pins host identity before sending credentials, keeps credentials outside the renderer, and reconnects safely.
- [x] Build a separate sandboxed Electron MAS target using the existing renderer and official branding; exclude the execution engine and PTY modules.
- [x] Show connection/recovery states, preserve the workspace while disconnected, and use Store-owned updates.
- [x] Verify transport auth boundaries, revocation and a signed host/client workflow with approvals, streaming, edits and a terminal.
- [ ] Complete the full parity matrix, real CLI and fresh-user acceptance.
- [x] Sign and open the local preview, verifying actual App Sandbox and displayed UI.

## Preview landing and delivery limits

Val approved landing the opt-in development preview through PR #119 after implementation
verification. This approval covers integrating the preview; the parity, provisioning and
App Review gates below remain required before claiming a finished Store edition or shipping it.

The published v0.0.7 Developer ID app and Companion build 4 stay unchanged. This work is
an isolated development preview until the full parity matrix in `mac-app-store.md` passes.
Mac App Store eligibility, a macOS App Store Connect record, distribution provisioning,
TestFlight processing and physical acceptance remain shipping gates. Do not label a normal
darwin Electron bundle or the iPhone compatibility app as a Mac App Store build.

A first local preview may use Developer ID signing for the MAS binary; it must still
actually run with App Sandbox. If proper local provisioning is required, prepare the
complete build before requesting the specific missing Apple setup.

## Local evidence, 2026-10-05

The new `apps/store-desktop` workspace builds and typechecks. Three transport tests passed
(pair-once, saved access after host restart, events/revocation, wrong pin and URI boundaries).
A real host/client Playwright flow passed approval and a repository edit, a terminal command,
reconnection while preserving an unsent draft, and revocation. These tests use the existing
offline scripted engine; they are not live Claude/Codex or full parity proof.

An arm64 Electron MAS bundle was built and Developer ID signed with the existing Soul
Protocol identity. Strict deep signature verification passed. Its parent entitlements are
App Sandbox, outgoing network access and the product application group; child executables
inherit the sandbox. The opened `works.jev.modex.desktop` window displayed the official
pink identity and connection screen. An external sandbox check on the running process
returned `control=0 target=1 errno=0`. The private diagnostic is not included in the product.
At this initial opening, signed client/host pairing had not yet been exercised. The follow-up
signed smoke test below closes that basic workflow gap; full acceptance remains pending.

During the broader local regression run the Mac ran low on disk space. Three checksum-
verified duplicate v0.0.7 download files were removed from this session's temporary directory;
source, verification logs, published artifacts and the installed app were preserved.

The final source build and typecheck passed, as did 279 core/desktop/bridge unit tests.
The complete desktop end-to-end rerun passed all 101 tests (including the new real host/client
flow). The preceding run had 99 passes, a 90-second shutdown-hook timeout and a 30-second
window-startup timeout during local resource pressure. Both passed on the unchanged-source
rerun after disk space recovered; no timeout or assertion was relaxed. This records the
local infrastructure limitation without claiming it was fixed in application code.

After website PR #118 landed, main was integrated into this preview branch. The only
conflict was the root package scripts; the resolved scripts retain the Store build and
the website unit/browser suites. The integrated build, typecheck and all 289 unit tests
passed. The complete integrated end-to-end run passed 101 desktop and five website tests.
This integration does not close the signed-client or Store distribution acceptance gaps.

The final transport boundary checks also exercise rejected browser origins, altered HTTP
Host headers, missing/unknown grants and incompatible protocol versions. Revocation before
a request body completes prevents command dispatch; revocation during an accepted request
invalidates its authorization callback and withholds the eventual result. Already accepted
work remains host-owned, as stated in the host's consent and revocation dialogs.

## Approved preview integration, 2026-10-05

The final build and typecheck passed with 291 unit tests. The full desktop E2E run had 100
passes and one 90-second timeout while closing the iPhone-pairing test app. Its trace shows
all functional assertions passed before `Close context` stalled. The unchanged test then
passed in isolation (6.2 seconds); all five website E2E tests also passed. No timeout or
assertion was weakened. This is a recorded local shutdown limitation, not a claimed fix.

A separate Developer ID signed host and the signed MAS client completed a native smoke
test in an isolated project using the offline scripted engine. Both passed strict deep
signature verification, and 48 packaged host/client code files matched the tested build.
The client was confirmed sandboxed at runtime (`control=0 target=1 errno=0`). Explicit
host consent, pairing, an approved CONTRIBUTING.md edit, streamed output, the Changes diff
and a real host terminal command all worked. Saved access used the real OS encryption path
and a mode-0600 credential file, with no test cipher in the packaged client.

The client recovered automatically after an abrupt host restart and kept its unsent draft.
The host's listener closed after SIGTERM but the process remained, so the isolated test
process was force-stopped before this restart; this does not prove graceful host shutdown.
Relaunching the client restored access and the saved thread without a new invitation.
Revoking the client through the host menu disconnected it, removed its encrypted credential
file and left zero host grants. Fresh-user, sleep/wake, upgrade, real CLI/account flows and
the rest of the parity matrix remain release gates, along with Apple provisioning/review.
