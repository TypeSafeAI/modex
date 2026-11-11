# Signed sources through Debian dependency installation

## Observed failure

Earlier published candidate `188af741834512d2e9d1f73994167301dabbb1f8` completed all four signed Noble pocket updates (35.8 MB) and installed 114 host packages (38.5 MB), then failed its first baseline Debian install because `libnotify4` was not installable. `libappindicator3-1` was also unavailable as a recommendation. Installed application acceptance did not begin. The immutable job130703562477 raw log and `linux-188-dependency-failure-audit.json` are retained in `/Users/buns/Documents/Codex/2026-11-11/modex-closeout/`.

The later installer invoked default-source APT after the preparation helper removed its private source configuration. That boundary is demonstrated by source and the actual failing command. The runner's APT policy and exact default-index state were not retained, so the source/index mismatch remains a hypothesis; successful host preparation does not prove Debian dependency resolution or installed application acceptance.

## Candidate

The existing helper adds a CI-only `noble --install-deb <artifact>` mode. It accepts exactly one existing absolute regular nonsymlink `.deb` path, updates strict official signed sources, then installs that artifact through the same temporary source configuration before cleanup. It accepts no arbitrary APT flags or commands. Default host preparation still requests the same nine packages. All four Noble pockets, Ubuntu keyring, acquisition bounds and failure behavior remain.

A small Node wrapper connects both baseline and upgrade acceptance to this mode after existing manifest/hash verification. The direct helper invocation retains the original 180,000 ms command timeout, caught as missing during initial review and restored before delivery. This deadline does not prove atomic APT descendant termination. The workflow includes the wrapper in its native PR path filter. Installed-app, credential, KWallet, FUSE, CLI and final cleanup checks, the six-minute preparation limit and seven-minute installed-acceptance limit remain unchanged. No global source configuration, resolver or trust setting is rewritten. Each installer invocation performs its own bounded signed index acquisition.

## Verification and limits

The old helper plus empty Node wrapper failed two new regression cases, with eight existing cases passing. The corrected installation path passed ten cases; input/failure controls brought that to 13 passes. Tests execute the real shell and Node wrapper with synthetic sudo/APT; configuration creation, argument boundaries, failure handling and cleanup are real. A separate old-helper control confirms that malformed installer arguments were previously ignored. These tests do not resolve real packages or prove Linux installation.

The first full build/typecheck/unit run passed with 2,465 passes, 36 skips and zero failures/cancellations. It used the initial source before the restored wrapper timeout, so it is retained as superseded evidence. Final corrected-source build, workspace typechecks and units also passed with 2,465 passes, 36 explicit skips, zero failures and zero cancellations across 2,501 tests; source hashes remained unchanged. Commands, exit codes and retained logs are tracked separately in `linux-deb-sources-final-validation.json`. Independent final source review found no Critical, Important or Minor finding. Actual dependency resolution, installed acceptance, timing and fresh exact-head hosted qualification remain open. No Linux acceptance or local-model admission is claimed.

## Hosted installed checks on aa095b2

Linux job `130727611378` in native-platform run `43079391127` completed successfully on branch head `aa095b29ff310bd837cdf6aac6af9389c122e9af`. Its tested synthetic merge `a964ae45fcef154a8c5af933e3bcb79bbe09c0bf` has parents main `85143ee4cf9cf3760c5552e2226950a7cbbeb7f1` and that branch head; its tree `9a5d53a79e6bac51a04c815571d5dcdc60826911` exactly matches the branch. The retained installed artifact is `13884276115`; `aa095b2-native-platform-independent-audit.json` records its run, hash and receipt binding outside disposable worktrees.

The signed-source installation acquired the previously unavailable dependencies and exercised eight installed launches: Debian baseline, upgrade, restart, basic_text refusal and automatic keyring restart, followed by AppImage baseline, upgrade and FUSE. Production SecretStore retained encrypted libsecret credentials across restart and package formats; basic_text refused new and overwrite writes while preserving ciphertext. Controlled KWallet5 version 5.115.0 checks also passed write, app restart and automatic daemon-restart recovery. Windows job `130727610986` separately passed three installed NSIS launches with DPAPI persistence and uninstall data preservation.

Both original receipts report nativeChecksPassed true and installerAcceptance pending. The 0.0.0 baseline is synthetic and does not qualify migration from historical release schemas. CLI version identity does not qualify authenticated account use or a real coding turn. Controlled KWallet5 is not KWallet6 or full graphical-login acceptance. Successful dependency resolution and recorded native checks do not prove the earlier failed runner's APT cache state, atomic descendant termination, product local-execution admission, human acceptance or issue closure.
