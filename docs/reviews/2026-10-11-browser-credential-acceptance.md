# Browser credential acceptance

The combined browser, UI, Space, Streamer Mode, and attachment implementation passed
build, typecheck, unit, desktop/site E2E, and independent review. A controlled real-CLI
fill passed earlier on unchanged credential code. The renewed check against the final
integration stopped during 1Password setup before Modex launched; it did not pass.
Normal signed-app acceptance and device Touch ID enablement remain separate release gates.

## Combined implementation evidence

The tested integration tree is `eaf43fd347d256db103c771bb0d091eeac26152c`.
It composes signed browser checkpoint `f9031a33dd195416cf2644738bdefe9850a2c722`
with signed attachment candidate `21784a9eebabc24dfb5ad7115c93e8b18fbba332`.
The actual #157 squash, `5e80b46912a6ba2f278ece14bf18efaac55a2c8a`, has exactly
the candidate's entire tree, `a3d8c96ff479c948cc01fd5443bd7003794e8c68`.
GitHub reports that squash signature as verified and valid. The browser checkpoint
retains original #152 head `8c7e5b96f179a96b0bbedd00329baef655d172fb` ancestry;
actual main supplies the exact tested attachment content. Signed delivery, current-head
checks, and protected landing are recorded separately on
[PR #152](https://github.com/TypeSafeAI/modex/pull/152).

The merge preserves the browser sign-in status beside the Streamer guest cover,
browser extension restore and attachment protocol setup before window creation,
private browser sessions, theme scripts in isolated world 999, Knowledge guest
suspension while chat is open, and the Store's unavailable attachment/browser stubs.

- Build and all-workspace typecheck passed.
- Unit suites: **670 passed, one optional OpenKnowledge integration skip**, zero failures.
- Full `MODEX_TEST_OPEN_KNOWLEDGE=1 npm run test:e2e`: **213 desktop tests passed in
  7.9 minutes; 7 site tests passed in 14.9 seconds**, exit 0. This includes all 14
  browser cases, the real OpenKnowledge flow, and attachment, Space, and Streamer checks.
- Whole SPEC and QUALITY reviews passed with no findings. Each passed 52 focused
  tests and compared 141 emitted JavaScript files with source output.
- All owned native/site processes exited. The source tree and preflight patch SHA256
  `5b57191dc144286ed38f00c66ba1980593f115eab55c18d75d3cacc74c221b3e`
  remained unchanged throughout the full run. Final evidence edits affect docs only.

The repair binds each fill to its initiating top-frame document and URL using a random
isolated-world token. Navigation and `pagehide` permanently revoke it. Final checks,
token consumption, and field writes execute synchronously together. Best-effort token
cleanup cannot hold the busy gate behind a hung page. The native chooser tracks the
initiating frame and all ancestors monotonically; sibling navigation does not cancel it.
Setup, display, and cleanup exceptions still complete its callback once and release tracking.

Credential race fixtures use controlled HTTPS documents and fake `op`. They prove the
tested application behavior, not a real vault unlock or biometric action. The selected
guest receives the fields, and matching approved extensions can read them. Credentials
are not returned through Modex app-bridge IPC or stored in the app renderer, transcripts,
or error messages.

## Earlier real 1Password development-build fill

The controlled live check ran at **10:24:45–10:25:14 UTC on 2026-10-11** and exited 0.
Both the harness and product resolved **1Password CLI 2.39.0** at `/opt/homebrew/bin/op`.
One temporary nonce-named Login with generated credentials was created, selected through
the actual native chooser, read through the production CLI path, and filled through the
production browser command. No `op` shim, dialog override, or credential injection was used.

- Guest username/password hashes matched the fixture; the form was not submitted.
  The guest had no Modex bridge or Node `require` and reported a secure context.
- Scoped checks found no password in the app's current HTML/attributes, form values,
  `localStorage`/`sessionStorage`, or captured stdout/stderr. After app exit and stream
  closure, all 99 regular files under the isolated Modex home (9,564,681 bytes, including
  Chromium storage) were checked for the exact password in UTF-8 and UTF-16LE; none
  contained it. This does not prove absence from arbitrary JavaScript heap, every IPC
  payload, or encoded/encrypted representations.
- That exact unchanged owned Login was recoverably deleted through the real CLI.
  The app exited normally without forced termination. All 11 source/build hashes stayed
  unchanged during that check.

The reviewed harness is `live-1password.mjs`, SHA256
`e9d2178c6784e7426d9f6ae35f54b8613fc295359e46e1f6551c43c34c335644`.
Private receipts remain in `apps/desktop/.probes/queue-audit/live-1password-1025/`
in the coordinator worktree. Independent assessment recomputed its 11 hashes, matched
the five source files to signed checkpoint `f9031a33`, and checked cleanup assertions.
A signed Git commit is not a signed application artifact.

The fixture used a protocol-intercepted HTTPS origin in a throwaway profile. It proves
the tested real-CLI fill path, not public TLS, real-site compatibility, a fresh biometric
unlock gesture, normal signed-app behavior, or live cancellation during vault reads.
No fresh biometric gesture was independently observed.

## Renewed final-build check blocked during setup

At **11:40:44 UTC on 2026-10-11**, the renewed attempt stopped before launching Modex.
The real CLI could not connect to the running 1Password desktop app; a subsequent
recovery listing reported the same connection timeout. Window inspection also timed out.
The desktop connection must be restored before exact fixture lookup and retry.
No final-build native selection, filling, leak scan, or cleanup pass is claimed.

The creation result is **uncertain**: no item ID was returned, so fixture absence and
cleanup cannot be established. No broad deletion was attempted. The unique intended
fixture metadata is retained privately for exact identification after connectivity returns.
The earlier check's confirmed cleanup applies only to its own earlier Login.
Private setup and diagnostic receipts are in
`apps/desktop/.probes/queue-audit/live-1password-final-1140/` in the coordinator worktree.

All **10 credential-core hashes** (five TypeScript sources and five emitted JavaScript
files) still match the earlier passed receipt exactly. The renderer HTML hash changed
with the integrated UI; all 11 current hashes match the renewed setup receipt. This
preserves evidence for the unchanged core without claiming a renewed integrated live pass.

## Release gates

Renewed integrated development-build acceptance and exact lookup/cleanup of the uncertain
fixture remain external follow-ups. The setup failure occurred before Modex launched;
it does not invalidate the combined automated results or establish a product failure.

Normal signed-app 1Password acceptance remains explicit: real unlock, selection,
no-submit fill, cancellation during listing/item reads/navigation/close, and absence
of credentials from app state, logs, and errors. Delivery records on PR #152 are separate
from these external acceptance gates.

Device Touch ID stays disabled and the default artifact omits the restricted WebAuthn
group. No matching standalone Developer ID provisioning profile is available; the Store
profile belongs to a different distribution channel. Enablement requires a separate
provisioned change and real signed WebAuthn create/get, restart/reuse, selection/cancellation,
and session-separation acceptance on supported hardware.
