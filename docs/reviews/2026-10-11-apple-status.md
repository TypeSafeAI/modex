# Apple status receipt, 2026-10-11

Mac 0.0.8 and Companion 0.1.0 (5) have approved beta reviews. Production drafts remain incomplete. This receipt records authenticated App Store Connect GET responses from **2026-10-11 06:41:06 through 06:42:20 UTC**.

The existing release API configuration was resolved through 1Password after Val authorized Touch ID. No build, metadata, tester assignment, submission, or release was changed. This readback supersedes the October 6 waiting-for-review states and the earlier October 11 authentication-blocked attempts.

## Latest builds and beta review

| App | Latest uploaded build | Processing | Internal state | External state | Beta review |
| --- | --- | --- | --- | --- | --- |
| [Modex Mac App Store](https://appstoreconnect.apple.com/apps/6819549715/testflight) | 0.0.8 (`b65a5d8f-c3b3-480a-9164-e421aee66c71`), uploaded October 6 at 23:38:27 UTC | `VALID`, not expired | `IN_BETA_TESTING` | `BETA_APPROVED` | `APPROVED`; submitted October 6 at 23:43:36 UTC |
| [Modex Companion](https://appstoreconnect.apple.com/apps/6818982013/testflight) | 0.1.0 (5), `ba880ae0-e6f9-4c29-9d3c-ccdc87f0b96e`, uploaded October 6 at 23:32:51 UTC | `VALID`, not expired | `IN_BETA_TESTING` | `IN_BETA_TESTING` | `APPROVED`; submitted October 6 at 23:37:23 UTC |

The API supplied submission timestamps, not approval timestamps. Mac 0.0.7 and Companion build 4 retain `REJECTED` beta-review states; those are earlier builds. The latest-build query sorted by upload date and returned both Mac builds and the five latest Companion builds.

The latest Mac build is assigned to `Modex Internal` and `Public`. The latest Companion build is assigned to `Internal` and `External`. Both external groups have public links enabled. Group membership was read without retrieving tester identities or public-link values. No installation or physical-device acceptance was performed.

## Production drafts and listing fields

| Record | Draft | State | Selected build | Review information |
| --- | --- | --- | --- | --- |
| Mac app `6819549715`, `works.jev.modex.desktop` | `MAC_OS` 0.0.8 | `PREPARE_FOR_SUBMISSION` | Valid 0.0.8 build above | Review notes present (2,085 characters); all four review contact fields present; demo account not required |
| Companion app `6818982013`, `works.jev.modex` | `IOS` 1.0 | `PREPARE_FOR_SUBMISSION` | None | No production review-detail record |
| Same Companion record | `MAC_OS` 1.0 | `PREPARE_FOR_SUBMISSION` | None | No production review-detail record |

All three drafts have one `en-US` localization. Description, keywords, support URL, marketing URL, promotional text, and what's new are empty. Each has **zero screenshot sets** and no copyright value. Both app-information localizations have a name, but no subtitle or privacy-policy URL. These observations include optional fields; they are not a claim that every empty field is required.

Mac production review notes and beta review notes are present and describe demo access. Companion beta review notes are present (2,368 characters), mention the demo, `modex://demo`, QR access, and the Mac, and include all four review contact fields. Both beta-review records have `demoAccountRequired=false` and empty demo-account credential fields. Contact values and note bodies were omitted from this receipt.

The Companion beta version is `0.1.0`, while its existing production drafts are `1.0`. Reconcile the intended version and platform before choosing a production build. The additional Companion `MAC_OS` draft was observed without changing or deleting it.

## Evidence and remaining limits

The GET requests covered app identities, builds with prerelease versions and beta-review relationships, production versions and selected builds, version localizations, screenshot sets, production and beta review details, app-information localizations, and beta groups with build assignments. The successful receipt contains no API errors.

The sanitized response is stored locally at `apps/desktop/.probes/asc-status-sanitized.json` with mode `0600`; this ignored file is not a repository artifact. Its SHA-256 is `5f4bad458596a31e918ec543fc09c82803dc9e049e205c537b8246f7f36bd14f`. The local GET-only query script is `apps/desktop/.probes/asc-status-readonly.mjs`. API keys, JWTs, issuer values, reviewer contact values, and demo-account values were not written to the receipt or tool output.

Production submission still needs completed listing fields and screenshots, Companion review information and build selection, and verification against the final candidate. Reviewer message threads, agreements, pricing, availability, App Privacy responses, and the age-rating questionnaire were not inspected. The app-information age-rating fields returned null, which does not establish the questionnaire's state.

Beta approval applies to the uploaded October 6 builds. It does not verify this branch's later networking changes, signed runtime parity, fresh-user behavior, physical iPhone operation, secondary-network recovery, or production acceptance of the separate-host architecture. See the [Store readiness audit](2026-10-11-store-readiness.md) and [Companion readiness ledger](2026-10-11-companion-apple-readiness.md) for those gates.
