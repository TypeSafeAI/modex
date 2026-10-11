# Mac Store readiness, 2026-10-11

The Store client implements discovery, consented host launch, native authorization, saved access, reconnection, revocation, and an offline demo. Full desktop parity and production Store acceptance remain unproven. Use this audit to select the next acceptance work and prepare the listing without treating source coverage as signed-build evidence.

Audit baseline: `6c00c52d372adc0f94c6dd667bcf97b671363248`, branch `companion-readiness`. This document records that baseline; later implementation in the same branch needs its own verification receipt. No Apple metadata, build, review submission, tester assignment, or release was changed by this audit.

## Current evidence and its limits

| Evidence | Result | Scope |
| --- | --- | --- |
| Source inspection | Discovery and launch are present in `desktop-discovery.ts`, `desktop-system.m`, and Store main | Corrects the unchecked discovery items in `mac-store-preview-plan.md`; does not establish signed runtime behavior |
| Narrow command run on October 11 | `node --test apps/desktop/dist/test/desktop-host.test.js apps/store-desktop/test/mas-release-config.test.mjs`: 12 passed, 0 failed | Desktop tests used existing compiled output. A fresh build is required before attributing this result to the final branch. Store release-config tests read their source module directly |
| Existing Store source E2E | Two connected-host tests and two offline-demo tests inspected | These use `MODEX_E2E`, a mock coding engine, mocked native confirmation, and plaintext test credential storage. They do exercise the real loopback host transport and a real shell |
| Previous signed smoke | October 5 ledger records sandboxed MAS preview, consent, scripted coding/edit, Changes, real terminal, saved encrypted access, restart, and revocation | Historical evidence only. It did not cover fresh macOS users, current source, real coding turns, full parity, or graceful host shutdown |
| Apple delivery and current readback | October 6 builds Mac 0.0.8 and Companion 0.1.0 (5) now have `APPROVED` beta reviews in the October 11 GET receipt | Production drafts remain `PREPARE_FOR_SUBMISSION`; approval applies to those uploaded builds, not the later source changes |
| Installed bundles, read-only inspection | `/Applications/Modex.app` is 0.0.10 with desktop protocol 1; `/Applications/Modex Host Preview.app` is 0.0.7 with protocol 1; `/Applications/Modex 2.app` is Store 0.0.8 | Each passed `codesign --verify --strict --deep`. This is neither a launch test nor proof that the installed Store app matches current source |
| October 11 source screenshots | Three actual Store 0.0.8 offline-demo captures, each 1440 × 900; renderer reported zero page errors and created no host credentials | Prepared locally after the full workspace build. Isolated source app in `MODEX_E2E` mode, not signed MAS/TestFlight acceptance; see the capture manifest below |

The Store workspace is version `0.0.8` at this baseline. The installed Store preview also includes an older `0.0.1` bundle. Record the exact bundle path, version, source commit, package checksum, and signing identity for acceptance so a different Modex installation cannot supply accidental proof.

References: [historical Store preview evidence](../mac-store-preview-plan.md), [October 6 review-access receipt](2026-10-06-review-demo-access.md), [October 11 Apple status receipt](2026-10-11-apple-status.md), and [Store source/run instructions](../../apps/store-desktop/README.md).

## Parity matrix

“Source coverage” identifies code and tests inspected, not a fresh pass of every named test. “Pending” means there is no current signed/live acceptance receipt for the row. Store updates intentionally remain App Store-owned.

| Surface | Implementation and source coverage | Required Store acceptance / disposition |
| --- | --- | --- |
| No-host launch and review access | Store `demo.ts`; `store-demo.spec.ts`; `demo.test.mjs`. In-memory approvals, sample files/diffs, scripted replies, terminal echo, reset, and exit | Pending current signed build. With no account, host, or network, complete demo, reset, exit, and relaunch without creating host access |
| Running-host discovery | `desktop-discovery.ts` validates record name, size, protocol, port, fingerprint, version, and live TLS pin. `desktop-host.test.ts` checks live/stale records and approval boundary | Pending real application-group lookup in the sandbox, malformed/forged records, multiple hosts, and stale records after a crash |
| Compatible installed-host discovery and launch | `desktop-system.m` checks permitted bundle IDs, protocol marker 1, Apple signature and team `9LR8Z8UQ9X`; revalidates immediately before `NSWorkspace` launch. Store main waits for a discovery record | Pending native positive/negative tests for wrong team, missing marker, absent app, stopped host, and host already running. No dedicated native helper test exists at this baseline |
| Installing/upgrading a host while welcome stays open | Store main resolves the `system` promise once, including the installed-host result | Gap: refresh native installed-host lookup on a later check/connect; prove an installation made after opening the client can be discovered without restarting the client |
| Native consent and code comparison | Host `index.ts` shows a six-digit comparison dialog; `desktop-host.test.ts` and connected Store E2E cover the authorization boundary | Pending actual native dialog with no test override. No grant, credentials, or workspace before Allow; mismatched code must be cancelled |
| Denial and cancellation | Unit tests assert neither denial nor cancellation persists credentials or grants; host confirmation uses an abort signal | Pending native deny, client cancel, window close during confirmation, and retry. No prior consent may leak into the retry |
| Manual connection link | One-time five-minute invitation, loopback-only URI, TLS identity pin, duplicate-field rejection | Pending signed fresh pairing, expired/reused link, malformed link, and wrong identity. Never record the link or token in evidence |
| Saved pairing and Keychain | Store main uses `safeStorage`, mode-0600 atomic credential writes, stable installation ID; E2E restores access after relaunch | Pending fresh-user Keychain permission, locked/unavailable Keychain, corrupt credential file, client relaunch, and system restart. E2E test encryption is not production Keychain proof |
| Reconnection and stream recovery | `DesktopClient` reconnects SSE with backoff; connected E2E preserves an unsent draft across host restart | Pending sleep/wake, interrupted response, host/client restart order, missed events, and multiple clients. Unsent drafts only survive the renderer lifetime, not a guaranteed app restart |
| Incompatible/changed host recovery | Discovery filters protocol; `/connect`, `/pair`, and `/invoke` reject incompatible protocol; pins reject changed/expired certificates | Gap: saved-connection errors currently fall into generic retry. Add explicit identity/version recovery states and acceptance for compatible upgrades, incompatible upgrades, port conflicts, and certificate replacement |
| Revocation and in-flight requests | Unit tests reject incomplete requests after revocation and withhold results for revoked in-flight calls; E2E removes saved access and returns to welcome | Pending current signed native revocation, stale-token reconnect, and concurrent requests. Already accepted work remains host-owned; revocation does not retroactively undo an accepted operation |
| Project picker, add/remove, and branch status | Shared host command registry owns project actions and native directory picker | Pending through Store transport: picker focus/cancel, protected folders, add/remove, branch status, invalid paths, and relaunch. The current picker appears in the host, not the sandboxed client |
| Local and worktree threads | Host `ThreadRunner` owns create, rename/update, delete, follow-up, and worktree scripts | Pending through Store transport: local/worktree creation, correct cwd/branch, switching, archive/delete, cleanup, and concurrent clients |
| Claude and Codex authentication | Connected Store forwards `chatgpt:*`, `claude:*`, and backend-health commands to the host. Historical October 5 probes detected existing CLI sessions | Pending real current CLI reuse, explicit sign-in, cancel, account switch, sign-out, missing CLI, executable override, and authentication error recovery. Detection alone is not a coding-turn acceptance test |
| Coding turns and lifecycle | Host owns `thread:send`, retry, stop, follow-up, model listing, and routing. Store E2E checks a scripted approval/edit/reply | Pending one real Claude turn and one real Codex turn from the Store UI, plus send failure, retry, stop, follow-up, model selection, and no duplicate execution across disconnect |
| Approval modes and rules | Shared approval UI and host `thread:answer`, rules, and preview commands | Pending Store tests for approve, deny, persistent choices, stale approval, rule preview without judge, judge failure, and disconnect during a decision |
| File browser, Changes, diff, and revert | Shared renderer; host file/Git handlers. Historical signed smoke inspected an edit/diff | Pending current Store read/list/diff/revert, large files, renamed/deleted files, unsaved state, and error paths using a disposable repository |
| Terminal | Host PTY operations/events; connected Store E2E writes to and closes a real shell | Pending signed input, resize, copy/paste, repeated tab open/close, reconnect, thread removal, and host shutdown without orphaned PTYs |
| Settings, routing, models, and usage | Shared UI and most host settings/routing commands | Pending Store persistence and error recovery for every setting, model refresh, routing, usage, and simultaneous clients; source desktop tests alone do not exercise Store transport |
| Themes, layout, Streamer Mode, and focus | Shared renderer; offline E2E verifies disposable theme/layout preferences | Pending connected Store persistence, keyboard and pointer resizing, privacy masking, streaming changes, focus order, minimum window size, and human keyboard/VoiceOver acceptance |
| Clipboard and external/system actions | Clipboard is handled in Store main. Workspace browser is client-owned; host owns file/terminal opening. Store main denies renderer navigation and allows new-window HTTPS links | Pending signed native behavior, guest isolation, unsupported schemes, disconnected guest removal, and reopening after connection recovery |
| Workspace browser | Store main instantiates `WorkspaceBrowser` and handles its channels locally | Pending Store-specific navigation/back/reload, crash/disconnect cleanup, bounds/resize, and guest inability to invoke host commands |
| Space, pages, and Knowledge | Store renderer passes `spaceEnabled={false}`. Several host Space read/write channels exist, but export, Knowledge operations, and project maintenance controls are `localOnly` | Explicit parity exclusion. Do not advertise Space/Knowledge in the Store listing. A separate design/implementation must define permitted host actions, client guest views, and export before enabling |
| Modex account sign-in | Host `modexAccount:*` channels are `localOnly`; shared account component can request these channels | Explicit parity gap. Provide an accurate unavailable state or implement Store-owned identity flow; do not expose unknown-command failures as a working account connection |
| Workspace menu shortcuts and window lifecycle | Shared renderer handles workspace keys; the Store-owned `WorkspaceBrowser` already forwards native guest `before-input-event` keys through `workspace:shortcut`. Store preload delivers them to the renderer. Window activation and close lifecycle exist | Existing keyboard paths need Store-specific coverage. No explicit native Workspace application menu is installed; add menu actions by reusing the existing shortcut messages without duplicate key listeners. Test renderer and focused-guest keys, menu invocation, reopen, focus, quit, and cleanup |
| iPhone Companion controls | Connected host exposes Companion status/start/stop/reset. Store demo reports unavailable | Pending through Store transport: start/pair/reset/revoke and status after host restart. Keep phone and desktop grants distinct |
| Attachments | Not on baseline main. PR #157 at `5d79f2effe5d2038295bd84b6f7c046bf6596aa0` explicitly blocks every connected Store `attachments:*` channel and labels demo attachments unavailable | Explicit Store exclusion until the separate connected-Store follow-up lands and is verified. Do not represent PR #157 as Store attachment delivery |
| Updates and packaging | Store `updates:check` returns `null`; separate MAS target; release-config tests check profile and separate installer identity | Intended difference. Pending final package audit, entitlements, engine/PTY exclusion, Apple validation, processing, and actual macOS TestFlight installation |

Primary test files: [`desktop-host.test.ts`](../../apps/desktop/test/desktop-host.test.ts), [`store-desktop.spec.ts`](../../apps/desktop/e2e/store-desktop.spec.ts), [`store-demo.spec.ts`](../../apps/desktop/e2e/store-demo.spec.ts), and [`mas-release-config.test.mjs`](../../apps/store-desktop/test/mas-release-config.test.mjs).

## Attachment coordination

[PR #157](https://github.com/TypeSafeAI/modex/pull/157) was open at the audited head. Its connected Store guard is broader than the PR description's offline-demo bullet: `connectedInvoke` answers attachment requests locally and never forwards them. This avoids sending base64 files through the host's existing 1 MiB JSON request limit or presenting an unimplemented `modex-attachment:` URL handler as functional.

Keep this guard until the Store follow-up provides bounded authenticated byte transfer, sandbox-compatible picker/drop/paste, a host-backed thumbnail/open path, cleanup on removal/deletion, and clear per-file/count failures. Verify both real CLIs with a PNG and a non-image file, retry reuse, disconnection, and revocation during upload. Update listing claims and screenshots only after that exact follow-up head has Store acceptance evidence. Do not weaken the generic RPC body limit just to accommodate attachments.

## Real CLI and fresh-user acceptance packet

Run these steps against the final candidate, outside E2E mode, on a fresh macOS user. A different `MODEX_HOME` under the current account does not satisfy this gate. Coordinate desktop tests with native/mobile runs so they do not compete for app focus or simulator state.

1. Record macOS/architecture, fresh-user status, source commit, host/client versions, package checksums, signature verification, entitlements, and runtime sandbox evidence. Install the exact signed host and MAS candidate through the intended delivery path. Preserve the regular account's apps, credentials, and projects.
2. Before installing or opening a host, verify welcome recovery and complete the offline demo. Confirm no network host, account, real filesystem action, or coding CLI is needed. Exit/reset must preserve any real saved access and preferences.
3. Install a compatible signed host, return to the still-open client, and discover it. Exercise closed host and already-running host. Compare native codes, deny once, cancel once, then allow once. Confirm no grant before consent and no second engine on an existing host launch.
4. Open a disposable Git project. With the host's existing authenticated Claude and Codex CLIs, complete one narrow real turn per CLI, record the actual CLI version/model and redacted result, and verify the intended repository change. Check sign-in reuse without copying credentials to the renderer. Exercise retry, stop, follow-up, approval, denial, diff/revert, and terminal cleanup.
5. Create and remove a worktree thread. Verify settings, themes, keyboard/pointer resizing, window reopen, supported shortcuts, privacy masking, workspace browser isolation, and accessible failure states. Keep excluded features visibly unavailable.
6. Test sleep/wake, client relaunch, host restart, offline recovery, locked Keychain, incompatible host, replaced identity, and a compatible upgrade. Require actionable recovery and no duplicate turn. Revoke while idle and during an in-flight action; verify the old grant cannot dispatch again and accepted host work is described accurately.
7. Capture the final Store UI using synthetic content and the real candidate. Keep native confirmation images private as evidence, without tokens, pairing links, account identities, or unrelated windows. Finish actual macOS TestFlight installation and reviewer access before claiming release readiness.

Record each row as pass/fail/not-run with timestamp, exact artifact, action, expected result, observed result, and a sanitized screenshot/log path. Native keyboard/VoiceOver and physical-device acceptance remain separate from automation.

## Apple status refresh

Authenticated GET readback succeeded at **2026-10-11 06:41:06 through 06:42:20 UTC** after Val authorized the existing 1Password Touch ID prompt. The primary checkout's `.env.release` supplied the existing API configuration. This supersedes the earlier authorization timeouts and the browser passkey gate. No key, JWT, issuer, reviewer contact value, or demo-account value was printed, and no Apple state was changed. See the [current Apple status receipt](2026-10-11-apple-status.md) for query scope and the sanitized local evidence checksum.

| App | Record | Latest build | Current recorded state |
| --- | --- | --- | --- |
| Modex Mac App Store | `6819549715`, `works.jev.modex.desktop` | 0.0.8, build ID `b65a5d8f-c3b3-480a-9164-e421aee66c71` | Processing `VALID`, internal `IN_BETA_TESTING`, external `BETA_APPROVED`, beta review `APPROVED`; 0.0.8 production draft `PREPARE_FOR_SUBMISSION` with this build selected |
| Modex Companion | `6818982013`, `works.jev.modex` | 0.1.0 (5), build ID `ba880ae0-e6f9-4c29-9d3c-ccdc87f0b96e` | Processing `VALID`, internal and external `IN_BETA_TESTING`, beta review `APPROVED`; 1.0 `IOS` and `MAC_OS` production drafts `PREPARE_FOR_SUBMISSION`, neither with a build selected |

The latest builds are assigned to their internal and public-link-enabled external groups. All three production drafts have empty `en-US` description, keywords, support URL, marketing URL, promotional text, and what's new fields, zero screenshot sets, and no copyright. Both apps lack a privacy-policy URL. Mac production review notes and contacts are present; Companion production review details are absent, although its beta review notes and contacts are present. Reconcile Companion's `0.1.0` beta train with the `1.0` production drafts before selecting a candidate. Optional empty fields are recorded without treating every one as mandatory.

Reviewer message threads, agreements, pricing, availability, App Privacy responses, and the age-rating questionnaire were not inspected. Beta approval does not establish current signed-build parity, physical-device acceptance, or production acceptance of the separate-host architecture. No historical submission/update script was run.

## Draft listing fields

These fields are prepared locally, not applied in App Store Connect. They intentionally exclude attachments, Space/Knowledge, and Modex account sign-in. Validate them against the final uploaded build and the current Apple decision before saving.

**Description**

> Modex brings coding conversations, approvals, project files, and changes into one Mac workspace.
>
> Explore the built-in offline demo without an account or host. Try sample threads, approve or deny a proposed change, inspect a sample diff, and send a follow-up. Demo replies, files, and terminal input are simulated and resettable.
>
> To work with your own projects, connect to a compatible Modex host that you install separately on the same Mac. Compare the connection code and approve access in the host. Your projects, coding tools, existing CLI sign-ins, and terminal processes remain on that host.
>
> In a connected workspace, organize project threads, review proposed actions and file changes, and follow coding turns from your installed Claude Code or Codex CLI. Those tools require their own installation, sign-in, and service access. The Mac App Store app does not include a coding-service subscription.
>
> You can remove the Store client's access from the host's Desktop access menu. Updates to this Store edition are delivered through the Mac App Store.

**Keywords** (77 characters)

```text
coding,developer,projects,threads,approvals,diffs,terminal,workflow,workspace
```

**Support URL draft:** [Modex issues](https://github.com/TypeSafeAI/modex/issues). A direct unauthenticated GET returned HTTP 200 on October 11. This is an existing public support surface; verify that its support/contact content meets the final listing needs. The README's `https://modex.build` and the guessed `/support` path failed DNS resolution from this machine, so they are not verified support destinations. No new support page was created.

**Reviewer notes draft**

> Open “Explore a demo workspace” on the welcome screen. No account, host installation, pairing code, or network connection is required for this mode. The visible Offline demo banner identifies simulated behavior.
>
> Approve or deny the sample action in “Review launch changes.” After approval, inspect the sample README diff and file. Send a follow-up with Command-Return, create a sample thread, and try the terminal's labeled input echo. Reset demo restores the fixture; Leave demo returns to the connection screen. No shell or live coding model runs in the demo.
>
> Real project operations require a separately installed compatible Modex host on the same Mac. The Store app can discover and open an existing compatible host after you choose its connection button. The host then displays a native six-digit confirmation. Access is saved only after approval and can be revoked in Desktop access. The Store app does not download or install the host or coding CLIs. Coding execution and terminal processes remain host-owned.
>
> Attachments, Space/Knowledge, and Modex account sign-in are not claimed as Store features in this candidate. The Store app receives updates through the Mac App Store.
>
> Please assess both the built-in demo's adequacy for review access and the separate-host architecture. We do not treat demo access or a processed build as prior acceptance of that architecture. A live-host review arrangement can be supplied if required.

Before using those notes, verify the final UI labels and that unsupported actions show a clear limit. Preserve the existing authorized review contact; do not invent credentials, a demo account, a hosted execution service, or an Apple approval.

## Screenshot inventory and capture plan

Apple currently accepts Mac screenshots at 1280 × 800, 1440 × 900, 2560 × 1600, or 2880 × 1800. All are 16:10. [Apple screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/).

| Existing asset | Actual pixel dimensions | Disposition |
| --- | --- | --- |
| `docs/screenshots/01-thread-approval.png`, `02-thread-complete.png` | 1786 × 1049 | Older desktop evidence, not current Store captures or an accepted Mac listing size |
| `docs/screenshots/03-minimum-window.png` | 900 × 600 | Minimum-window desktop evidence, not a Mac listing size |
| `docs/screenshots/04-graphite-approval.png`, `05-graphite-complete.png` | 2760 × 1760 | October 3 desktop mock-engine captures; preserve provenance, do not relabel as Store |
| October 6 `modex-review-access-2026-10-06/ios-demo-screens/*.png` | 1206 × 2622 | Three iPhone simulator captures, not Mac assets |
| October 6 `modex-pr128-review-2026-10-06/screenshots/demo-*.png` | 1206 × 2622 | Four iPhone simulator demo captures, not Mac assets |
| `modex-demo-qr.png` in both October 6 artifact directories | 768 × 768 | Reviewer access QR, not an app screenshot |

No current Store listing screenshots were found in those inspected locations. Existing artifact directories are under `/Users/buns/Documents/Codex/artifacts/`; their images are not checked-in evidence from this branch. The subsequent source capture below prepares new Store images without changing or relabeling those older assets.

### New source-built Store captures

After the workspace build completed, standalone Playwright Electron captured the real Store renderer on macOS 26.7.1 at **2026-10-11 06:30 UTC**. Each PNG is exactly **1440 × 900**, captured with CSS pixel scaling, without image editing, injected styles, or altered UI text. The built-in in-memory `StoreDemo` supplies all content. No host, coding CLI, real project files, or terminal process was used.

| Image | Content | SHA-256 |
| --- | --- | --- |
| [Offline approval](../screenshots/store-2026-10-11/01-offline-approval.png) | Pending sample approval with the original README open in Files | `2ab572f0cdb829edaa4c4168e073d42ff90bb8f83c1c92cde67ed8624815abc5` |
| [Offline review](../screenshots/store-2026-10-11/02-offline-review.png) | Approved sample change and its README diff | `0f1dd1fd718c6bc2750474a308941392a19ee20324ea402348b2f80ca55dfcfd` |
| [Offline follow-up](../screenshots/store-2026-10-11/03-offline-follow-up.png) | Scripted follow-up response beside the sample diff | `8b9fa3de2f3615713b47b808dc90ec0b92cc7bb47db2523a47fe744b49dbde16` |

The actual resize handles widened the workspace to 520 pixels and the sidebar to 264 pixels. The Jev theme and visible Offline demo banner are preserved in every image. Visual inspection confirmed readable Files/Review labels, synthetic content, no personal paths or credentials, and no Space/attachment feature claims. The capture app and its temporary profile were closed and removed after success.

The [manifest](../screenshots/store-2026-10-11/manifest.json) records source baseline, the [source worktree patch](../screenshots/store-2026-10-11/capture-source.patch), build-output hashes, app/runtime/OS versions, fixture limits, capture command, and image checksums. Build output remained unchanged during capture. These are prepared listing assets from a source build; they must be compared with the final uploaded build before use. They do not prove native sandbox behavior, live CLI acceptance, or TestFlight installation.

For the final signed candidate, verify or recapture the corresponding screens at an accepted Mac size:

1. Offline demo thread with a pending approval and its visible demo banner.
2. Approved sample change with Review/Files content and the demo banner.
3. A sample follow-up; a labeled simulated terminal is optional.
4. A connected workspace with synthetic project content only after signed acceptance; clearly disclose the separate host requirement in accompanying listing text.

Keep welcome, native authorization, denial, reconnect, and revocation captures in the review evidence packet. Do not make the listing a sequence of connection screens. Record source commit, exact app version/build, signing mode, fixture, theme, dimensions, date, and checksum beside each image. Inspect every image for real paths, identities, credentials, notifications, and unshipped features before upload. Do not resize old desktop screenshots and label them as fresh Store captures.

## Remaining gates

1. Implement the concrete recovery/parity gaps above, or document and visibly enforce each exclusion. Refresh `mac-app-store.md`, `mac-store-preview-plan.md`, and Store README claims from this matrix as part of the implementation PR.
2. Run the required fresh build, unit suite, Store transport E2E, and applicable full UI regression against the final branch. Record signed real-CLI and fresh-user acceptance separately.
3. Use the [October 11 authenticated Apple receipt](2026-10-11-apple-status.md) to finish the incomplete production drafts. Inspect reviewer messages and resolve any applicable feedback before a new submission; beta approval of the October 6 builds does not close the runtime or production gates.
4. Produce and inspect truthful final-candidate screenshots, finish support/privacy/review metadata, and record package validation and actual TestFlight installation.
5. Obtain explicit authorization for any new Apple upload, submission, or release. This audit supplies preparation, not that authorization.

Apple's current rules require sandboxing and constrain additional installations and host-dependent functionality; the separate-host approach remains an App Review eligibility question. Source correctness and demo access cannot settle it. [App Review Guidelines 2.4.5 and 4.2.3](https://developer.apple.com/app-store/review/guidelines/).
