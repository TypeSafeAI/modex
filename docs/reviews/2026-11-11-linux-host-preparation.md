# Linux native qualification host preparation

PR #498's signed application candidate `5edbb84ee58921c191912c0575a317fe40805a62` passed the required macOS job, paired iPhone job and Windows qualification. Linux qualification did not reach installed-app acceptance: two unchanged attempts timed out during APT host preparation. This receipt covers the resulting CI-only repair; it changes no application, native CLI, model, account, inference policy or product admission.

## Retained failures

| Attempt | Workflow run | Linux job | Result |
| --- | --- | --- | --- |
| 1 | 43040513548 | 130590736364 | Cancelled at the 30-minute job limit; Azure Ubuntu mirror DNS failed during index/package acquisition |
| 2 | 43040513548 | 130610413821 | The single targeted unchanged retry repeated the DNS failure and 30-minute timeout |

Both raw logs and GitHub timeout annotations are retained under `/Users/buns/Documents/Codex/2026-11-11/modex-closeout/`, with `private-trust-linux-first.*` and `private-trust-linux-attempt2.*` prefixes. The first failure was published on [PR #498](https://github.com/TypeSafeAI/modex/pull/498#issuecomment-6799549931) before the one retry. The retry endpoint returned HTTP 201 and an independent job read proved attempt 2; it was not an observation-timeout restart. No third unchanged retry was requested. Installer creation completed before the preparation failure, but installation/acceptance did not run and is not marked passed.

Local read-only DNS comparison resolved the Azure, archive and security hosts; it is not evidence of resolution inside the failing GitHub runner. No resolver or image source file was edited to evade that failure.

## Repair

The Ubuntu 24.04/KWallet5 job now invokes `scripts/prepare-linux-installed-host.sh` with its actual Ubuntu codename. The helper refuses non-Linux/non-CI invocation, a codename other than Noble and a missing or relative runner temporary directory. It creates an owned temporary deb822 source list and empty sourceparts directory. Only the two APT invocations select those sources; default image source fragments and the system resolver are not rewritten.

The selected HTTPS archive/security URLs remain official Ubuntu sources for Noble, Noble updates/backports and Noble security. Each stanza uses the image's existing Ubuntu archive keyring through `Signed-By`. Authentication/TLS checks are not disabled. The complete existing nine-package set remains unchanged, and update/install failures remain failures. See [Ubuntu source-list configuration](https://manpages.ubuntu.com/manpages/noble/man5/sources.list.5.html) and [APT invocation overrides](https://manpages.ubuntu.com/manpages/noble/man5/apt.conf.5.html).

APT method timeouts and retries are bounded, and strict index-update error handling prevents warning-only index failure from proceeding into package installation. The host-preparation step has a separate six-minute limit; the overall job remains 30 minutes. FUSE, the existing AppArmor setup, pinned CLI provisioning and actual installed Debian/AppImage acceptance retain their original behavior and limits. See [APT strict update failure](https://manpages.ubuntu.com/manpages/noble/man8/apt-get.8.html).

## Validation and limits

The real shell helper is exercised with only privilege escalation and external APT replaced. Temporary configuration, quoting, cleanup and exit propagation stay real. The initial focused cases failed against the original two APT commands, including the index-warning/install path, then passed with the repair. Final coverage contains seven passing cases, including failure-path cleanup, temporary paths containing spaces, invalid CI/OS/codename and missing/relative temporary-directory refusal. No real package installation ran on the developer Mac.

Root `pnpm build` passed, followed by a successful full `pnpm test`. After strengthening only test assertions and guard cases, the final full `pnpm test` passed with 2,427 passes, 35 explicit skips, zero failures and zero cancellations (2,462 total tests). The workflow/helper bytes stayed identical to the successful build; all three candidate input hashes remained unchanged during the final unit run. Exact commands, timestamps and input hashes are retained in `linux-host-full-validation-first.json` and `linux-host-final-unit-validation.json`; the final complete output is `linux-host-final-unit.log`.

Independent read-only review found no critical or important issue; the minor coverage suggestions were addressed and re-reviewed. Application/backend/renderer/Swift inputs remain unchanged, so the separately recorded 508-pass desktop E2E, 11 explicit skips, seven site passes, four real-model Electron lifecycle cases and offline coding receipts retain their original source/runtime provenance. They are not Linux host/installed acceptance evidence.

Fresh exact-head hosted qualification is still required. A successful local fake-APT test does not establish real APT acquisition, package compatibility, FUSE/AppArmor behavior or installed acceptance. No issue closure, feature activation, release, tag, TestFlight upload, installed-app replacement or other-owner cleanup is included.
