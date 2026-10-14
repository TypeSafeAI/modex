# Native Windows and Linux candidates

Development commands: `pnpm --filter @modex/desktop dist:windows` and
`pnpm --filter @modex/desktop dist:linux`. Each requires its native x64 host. Windows
also needs an MSVC x64 tools environment. The commands build core and desktop,
write candidates under `apps/desktop/release/native-{win32,linux}`, and never publish.

Windows NSIS installers are unsigned, per-user, do not launch automatically after
installation, and retain application data on uninstall. Linux targets are AppImage
and Debian (`modex`). macOS release-signing rules remain unchanged.

The Native platform builds workflow tests CLI arguments and Windows process ownership,
then builds candidate installers. Artifacts expire after three days. A manifest records
SHA-256 hashes, sizes, source commit/run identity, and installer acceptance as pending.
The [Windows cleanup run](https://github.com/TypeSafeAI/modex/actions/runs/38137332864)
passed all fourteen native checks: CLI arguments/npm launchers, owned descendant cleanup,
PTY input/OS resize/Ctrl-C, and six repeated shutdown cycles. The fixture owner exited
naturally with zero output workers and owned consoles; pipe handles returned to baseline.
It produced `Modex-0.0.10-windows-x64.exe` (116,976,509 bytes), whose downloaded SHA-256
matches the manifest and whose PE certificate directory is empty, confirming it is unsigned.

Earlier runs exposed a node-pty leak and stale Node stdout dimensions. A version/hash-checked
patch now closes the owned console, destroys input and disposes the output worker while
preserving exit status across output EOF ordering. Windows builds rebuild the addon against
pinned Electron headers; build and runtime guards reject unpatched prebuild fallback.
Resize acceptance reads a fresh child OS sample instead of cached stdout fields.

The [Windows installed acceptance run](https://github.com/TypeSafeAI/modex/actions/runs/38138212616)
passed verified NSIS installation, two launches of the real packaged app, terminal
input/output/cleanup with explicit cmd.exe selection, and production SecretStore DPAPI
encryption read across restart without changing ciphertext. The real NSIS uninstaller
removed the application and registration while preserving recorded threads, probe
ciphertext, default app-data markers and unrelated data. The downloaded evidence archive
matches GitHub's artifact digest. Forced process cleanup fails acceptance; existing
installations and local/self-hosted execution are refused.

Default Windows shell selection treats environment names case-insensitively.
Regressions reproduce and fix the incorrect PowerShell fallback for `ComSpec`/`comspec`.
The [follow-up native run](https://github.com/TypeSafeAI/modex/actions/runs/38138984311)
passed installed terminal use with ordinary `ComSpec`, DPAPI restart and uninstall.
All fourteen Windows CLI/PTY checks passed. The Ctrl-C fixture now waits for child exit
and a unique PowerShell prompt before sending the next command; a delayed child exit
exercises the distinction between signal delivery and shell readiness.

Linux GCC rejected unchecked terminal receipt writes in the
[initial run](https://github.com/TypeSafeAI/modex/actions/runs/38134189896).
After the helper handled partial writes, interruption and errors, the second run compiled
and produced AppImage and Debian candidates. Downloaded sizes and SHA-256 hashes match
their manifest, whose source is the PR merge of Canvas `05efc984` and platform `3de10de5`.
The third run also passed seven Linux terminal cleanup/job-control tests; two require
unavailable zsh or macOS. The [installed smoke run](https://github.com/TypeSafeAI/modex/actions/runs/38136494798)
then passed for Debian and extracted AppImage: verified hashes, packaged Electron 44.4.5
and ASAR startup, real terminal input/output/cleanup, graceful app close, and Debian
uninstall preserving recorded threads and unrelated data. Screenshots and runtime
identity are retained in the `native-installed-linux` artifact. The runner reported
`basic_text` with encryption unavailable. The
[credential acceptance run](https://github.com/TypeSafeAI/modex/actions/runs/38138984311)
then passed real libsecret encryption across app restart and Debian/extracted AppImage,
plus `basic_text` refusal of new and overwrite writes with existing ciphertext preserved.
The probe file retained mode `0600`; uninstall retained threads, ciphertext and unrelated
data. Downloaded Windows/Linux evidence archives match GitHub's artifact digests, and the
tested merge tree matches the platform commit. The earlier harness explicitly selected libsecret with one keyring process across app
restarts. The [environment acceptance run](https://github.com/TypeSafeAI/modex/actions/runs/38140210846)
now also passed credential reads after restarting the owned keyring daemon, with automatic
backend selection under a declared GNOME environment. The actual AppImage executable
started from a verified FUSE mount, passed terminal and credential checks, and released
that mount after graceful close. Both installed evidence archives match GitHub's artifact
digests; the tested merge tree equals platform commit `65c1ca6`. A full graphical login
session and KWallet remain outside this evidence.

The hosted-only manual-upgrade harness has passed on Windows and Linux. It builds a synthetic `0.0.0` baseline
and the current version from the same source into separate directories, verifies both
manifests, installs the baseline, and replaces it through NSIS/Debian or an extracted
AppImage directory. Runtime versions, saved thread titles/settings, unchanged encrypted
credentials and uninstall retention are asserted. Baselines are short-lived CI artifacts
and are never published. This establishes distinct-version package replacement, not
historical schema migration. The first hosted attempt used invalid `default_mode: plan`,
which the store correctly normalizes to `agent` on reload. The fixture now saves valid
`chat`, checks the returned and on-disk value before replacement, and requires that value
after restart. The [Windows upgrade run](https://github.com/TypeSafeAI/modex/actions/runs/38139835694)
passed NSIS `0.0.0` → `0.0.10`, saved thread titles/settings and unchanged DPAPI ciphertext,
then restart and uninstall retention. Its evidence archive matches GitHub's digest.
The same run passed Debian and extracted AppImage replacement with saved titles/settings
and unchanged libsecret ciphertext. The environment acceptance run repeated all three
upgrade paths successfully. Persisted composer draft acceptance belongs to the separate
updater integration.

Before release, collect native evidence for installed startup, packaged Electron addon
and helper loading, CLI arguments and account/login launches, PTY input/resize/Ctrl-C,
natural exit/close/disposal/owner-death cleanup of detached descendants, DPAPI and
libsecret/KWallet behavior (including unavailable-backend refusal), manual upgrade with
preserved data, and uninstall without unrelated data loss. Windows/Linux updates remain
manual. Candidate artifacts and cross-compilation do not satisfy these gates.

Windows job ownership covers ordinarily created descendants, not service/WMI execution.
Custom batch launchers are refused; recognized plain npm Node wrappers launch the real
Node entrypoint with unchanged arguments. A follow-up supports the exact standard npm
native-executable wrapper used by Claude Code, launching its `.exe` directly through the
owned supervisor. Added coverage rejects modified wrappers and preserves argument values.
The hosted harness now prepares pinned Codex `0.162.1` and Claude Code `2.1.296` in a fresh
runner-owned prefix and checks discovery, identity and version through the installed app's
production launcher. The [installed CLI acceptance run](https://github.com/TypeSafeAI/modex/actions/runs/38141701049)
passed on both platforms: production discovery and identity checks returned the exact pinned
versions. All sixteen Windows CLI/PTY tests passed, including exact arguments through a native
npm executable wrapper. Both installed evidence archive digests and the tested merge tree were
verified. These probes run only `--version`, with isolated profiles, and do not establish
account or inference acceptance. Linux credentials require an encrypted storage
backend and preserve existing files when storage is unavailable.

Local verification for the isolated platform change: full monorepo build, 494 passing
tests, desktop typecheck, configuration validation and workflow lint. Thirteen tests are
skipped: twelve require Windows and one is the existing opt-in live Knowledge test. Strict
Windows cross-compilation passes; the hosted results above provide the limited native
evidence gathered so far.
The Codex process-cleanup fixture also now waits for a valid PID; a deliberately delayed
PID write reproduces the earlier false process-survival assertion before the fix.

The packaged-demo test now uses the test process PATH instead of reading the user's
login profile. A controlled nine-second login shell reproduced its eight-second
approval timeout; the same test passes with profile lookup disabled through the existing
test seam. Production demo deadlines are unchanged.

KWallet5 acceptance passed on the disposable Linux runner at `a59f761` in
[run 38143281502](https://github.com/TypeSafeAI/modex/actions/runs/38143281502).
The installed app's production SecretStore retained encrypted credentials across app and
owned daemon restarts, including automatic selection under declared KDE5. The harness
creates a real wallet through KWallet's PAM key handoff with a random in-memory key,
checks the daemon PID, and flushes the wallet before shutdown. The downloaded evidence
archive's SHA-256 and the tested merge tree were independently verified. This does not
represent a full graphical/PAM login session, KWallet6, or real account acceptance.

## Integration after Canvas and worktree hygiene

The latest isolated candidate, `8352566`, passed both platforms in
[run 38147564357](https://github.com/TypeSafeAI/modex/actions/runs/38147564357):
sixteen Windows CLI/PTY checks, three NSIS launches, eight Linux package launches and
three KWallet5 launches. Downloaded evidence hashes and the exact tested tree were
independently verified. The later Canvas and worktree-hygiene merges require a new
verification pass on the reconciled source; these older receipts do not certify that tree.

The tag release workflow currently attaches only macOS artifacts. Windows/Linux shipment
still requires native builds and acceptance on the signed release tag, matching candidate
manifest and installed-app result identities/hashes, and publication of those exact
accepted installers. Synthetic baseline packages must never be release assets. Windows
remains unsigned and Windows/Linux updates manual. No platform release has been published.

The candidate reconciled against main `42223e2d` passed a fresh dependency install, full
monorepo build, all workspace typechecks, 805 unit tests (12 Windows-native skips on
macOS), 234 desktop E2E tests and seven site E2E tests. Real Knowledge coverage was
enabled. All 506 tracked files stayed unchanged through the gate. Independent review
confirmed current Canvas, browser and attachment source and macOS packaging
configuration were retained.

Fresh [native acceptance at `23ac60b`](https://github.com/TypeSafeAI/modex/actions/runs/38166464728)
passed both platforms. Sixteen Windows CLI/PTY tests and six cleanup cycles passed, along
with three NSIS launches, eight Linux package launches and three KWallet5 launches.
Five downloaded evidence archives matched GitHub digests. Both installed reports and
checkout logs identify test merge `705622af`, whose tree equals head `23ac60b` and whose
parents are that head and main `42223e2d`. The hosted harness checked installer hashes;
the independent local audit downloaded evidence archives, not the full installer archives.

One push iPhone run on that head failed with a keyboard/gesture stall, then a demo setup
failure caused by the saved pairing it left behind; the other iPhone run passed. A narrow
follow-up now resets to welcome before both demo entry paths. On a disposable simulator,
the original Back test failed with a real saved pairing and the corrected test passed;
all 33 native unit and 28 UI tests then passed without skips. The follow-up also passed
build, typecheck and 805 unit tests (12 Windows-native skips). This fixes test setup and
does not claim to fix the earlier keyboard stall. This native setup evidence belongs
to that follow-up. Every later integrated revision requires fresh hosted verification
before landing.

## Integration after the Knowledge repair

[Knowledge prerequisite #175](https://github.com/TypeSafeAI/modex/pull/175) landed as
`595c676`. The platform branch incorporates that exact main revision: successful CLI
status parsing excludes stderr diagnostics, and the real-editor reload test waits for
the next document and editor before removing its network handler.

The combined tree passed the full build, all workspace typechecks, 808 unit tests
(12 Windows-native tests skipped on the local Mac), all 234 desktop E2E tests and seven
site tests with real Open Knowledge enabled. All 506 tracked file hashes held throughout
that gate. Only these evidence/status documents changed afterward. The previously
recorded native setup proof and failures remain separate from this integration result.
Fresh required macOS checks and native Windows/Linux jobs verify each submitted revision;
[PR #173](https://github.com/TypeSafeAI/modex/pull/173) records the exact hosted receipts.

Installer candidate implementation and native test artifacts are distinct from release
publication. The combined release workflow below is prepared, but acceptance and
publication of the exact tagged Windows/Linux installers remain pending, along with
the account/session and historical-migration limits recorded above.

## Tagged release candidates

The protected Release workflow calls the native platform workflow for the same tagged
source. Each installed-app report includes its byte-verified candidate manifest and sets
`nativeChecksPassed` only after acceptance and cleanup succeed. The attachment job requires
matching source, run, version, architecture, file sizes and hashes, plus the signed macOS
scenario receipts. It copies only the five verified installers and publishes their hashes
and remaining acceptance limits into a draft release; private upgrade baselines are excluded.

This workflow first ran on an approved signed tag for v0.0.12 ([run 38465731604](https://github.com/TypeSafeAI/modex/actions/runs/38465731604)),
whose Windows and Linux candidates passed but were not published. It does not change the native
evidence or outstanding gates above. Windows installers remain unsigned, updates remain
manual, and `installerAcceptance` stays `pending` until the remaining account/session checks
have evidence. See [release signing](release-signing.md#candidate-attachment-checks).

The [release-patch native run](https://github.com/TypeSafeAI/modex/actions/runs/38230412498)
passed at `5189b57`. Both reports contain the verified candidate manifest and
`nativeChecksPassed: true`. The downloaded installer archives match GitHub's sizes and
digests; their manifests exactly match the installed-app receipts, and all three installer
byte sizes and SHA-256 values match. The tested merge tree equals that source head.
This proves the new report fields on that revision; it does not complete the pending
account/session checks or the first combined signed-tag execution.
