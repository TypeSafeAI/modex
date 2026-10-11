# Native Windows and Linux candidates

Development commands: `npm run dist:windows -w @modex/desktop` and
`npm run dist:linux -w @modex/desktop`. Each requires its native x64 host. Windows
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

A KWallet5 follow-up harness is prepared for the disposable Linux runner. It creates a real
wallet through KWallet's PAM key handoff using a random in-memory key, then exercises the
installed app's production SecretStore across app and daemon restarts, including automatic
selection under declared KDE5. It checks the exact owned daemon PID, flushes the wallet before
shutdown, and preserves credential ciphertext. Hosted execution is pending. This does not
represent a full graphical/PAM login session or KWallet6 acceptance.
