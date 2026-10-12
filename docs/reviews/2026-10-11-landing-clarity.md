# Landing clarity — 2026-10-11

## Scope

Replace the viewport-locked landing carousel and About modal with a scrollable product
story. Keep the dark/pink identity and existing release-feed validation. The hero states
the agent workflow, setup explains provider costs, and optional Companion requirements sit
beside its demonstration. Repository counts appear in the footer.

The three manual stages follow one actual CONTRIBUTING.md demo task: request, proposed
patch and approved diff. The two desktop assets are unchanged copies of the Graphite
captures in `docs/screenshots`, also present in published tag v0.0.10. They are explicitly
labeled scripted demos. Screenshot dialogs allow scrolling through larger desktop details;
original images remain accessible without JavaScript.

## Release evidence

The public GitHub latest-release metadata returned v0.0.10 (published 2026-10-09) and its
uploaded arm64 DMG. The published independent verification receipt identifies source
`dbbb33e7635df844711beec19f4fdb046f476c5e`, codesign/Gatekeeper/notarization acceptance,
and matching DMG/ZIP payloads. This review read that receipt; it did not reinstall or rerun
native release acceptance.

- DMG SHA-256: `41b6f8b5f44f4f13c1e0369cdc002650e70594207dc0a552a76090c59c707d67`.
- ZIP SHA-256: `440cbf701f4bd81e30abed5a050260c9ab9affdbd6315d9257922340a62522ac`.
- Installed `/Applications/Modex.app/Contents/Info.plist`: version 0.0.10,
  `LSMinimumSystemVersion=13.0` (read-only inspection).

`apps/site/release.json` and offline/no-JavaScript links now use v0.0.10. Browser tests
exercise v0.0.11 discovery, older responses, invalid URLs, offline fallback and exact count
labels; the release-feed implementation is unchanged.

## Verification

Repository build and site typecheck passed. `npm test` passed 833 checks with 13 expected
platform/optional-runtime skips. The full `npm run test:e2e` passed all 245 desktop and
7 site checks, with real OpenKnowledge enabled and no skips. The bounded run exited 0
in 959.5 seconds; its process group was empty after completion.

That run used frozen source identity
`bb604706e5799925ea172ecc21b47c7adc045dc9156a049fbe3029c59449287a` at base
`a976506ddc4a6f958ee4dbeb732f5d096bc9cbac`. Afterward, Val clarified the correct domain;
only site links/metadata, domain artwork and documentation changed. Desktop source stayed
unchanged. The final site build/typecheck, all 10 release unit tests and all 7 browser tests passed after these corrections.

The session's `.codex/landing-clarity/` ledger retains exact identities and logs. Visual
captures are in `output/playwright/landing-clarity/`.

The browser suite checks retained product copy and requirements at 320×568, 375×667,
390×844, 768×1024, 1024×768, 1440×900, 1920×1080, 844×390 and 667×375, including all
workflow stages, horizontal overflow, 44px primary/step/FAQ targets, and enlarged text.
It also covers manual keyboard selection, reduced motion, dialog close/Escape and focus
return, inline FAQ, and useful content/downloads with JavaScript disabled.

Automated browser keyboard checks do not constitute human VoiceOver acceptance.

## Public domain and launch

The initial `modex.build` reference returned NXDOMAIN. Val clarified that the correct
domain is `modex.codes`. It resolves, returns HTTPS 200, and is attached to Vercel project
`modex` under `0xbuns`. Its live release API returned v0.0.10 with a fresh snapshot.
No DNS records or registration needed changing.

Canonical/Open Graph URLs, the README homepage and generated README/social artwork now
use `https://modex.codes/`. The existing brand generator was run in an isolated scratch
folder; only the domain-bearing artwork was copied back. Original marks and native app
icons were not changed. Historical review notes retain their original observations.

Source verification is separate from deployment: verify the new hero, canonical URL,
release API and mobile page at the public domain after the protected PR lands.
