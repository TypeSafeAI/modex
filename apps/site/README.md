# Modex landing page

Vite/TypeScript site for **https://modex.codes**, with a small cached Vercel function for
public GitHub release metadata. The scrollable page follows a real demo task through three manually selected stages,
then explains agent access, worktrees, Pages/Knowledge, setup and the optional iPhone
companion. No WebGL, analytics or third-party fonts.

## Develop and verify

From the repository root:

```sh
npm install
npm run site:dev
npm run site:build
npm run typecheck -w @modex/site
npm run test -w @modex/site
npm run test:e2e -w @modex/site
```

Vite dev and preview expose the same `/api/release` handler as production. Browser tests
intercept this endpoint and exercise future releases, invalid responses, offline fallback,
periodic refresh, the full product story across desktop/mobile viewport sizes, manual workflow
selection, keyboard access, reduced motion, screenshot enlargement and JavaScript-disabled links.
Product copy and platform requirements remain in document flow at narrow or short sizes.
Set `MODEX_SITE_TEST_PORT` to give concurrent site checks their own port (default 5187).
Both the feed unit tests and site browser tests run in CI.

## Automatic releases and counts

`/api/release` fetches only fixed public GitHub endpoints for the repository, latest release
and paginated release assets. Requests are coalesced and cached for five minutes per warm
server, with an additional five-minute CDN cache and stale-while-revalidate. Open pages
refresh every five minutes while visible, including when they regain focus after that
interval. A new published release appears automatically after these caches refresh;
no rebuild or deployment is needed. This is periodic refresh, not an instant push.

Only a stable release with an uploaded, nonempty Apple Silicon DMG at the expected repository
URL can replace the links. All Mac buttons, version labels and release-note links update
together, and older or malformed responses cannot roll back a version already displayed.
`release.json` remains the verified static fallback for offline visitors, GitHub outages,
rate limits and disabled JavaScript. Advance that fallback only after independently verifying
the public release. Website metadata validation does not replace release signing checks.

Stars and forks come from GitHub repository counts. **Mac downloads** sums DMG and ZIP asset
downloads across all published stable releases and architectures, excluding drafts, prereleases,
checksums, verification logs and source archives. This measures downloads, not unique users.
Pagination is bounded; an incomplete total is never shown. Unknown counts stay hidden; cached
counts are labeled when the refresh fails. No GitHub token or visitor data is forwarded.

The iPhone buttons use the maintainer-approved public TestFlight invitation in `release.json`:
<https://testflight.apple.com/join/Qr14JKCh>. This is beta distribution, not an App Store listing. The CTA says “View TestFlight beta”;
Apple controls enrollment availability, and the site does not promise an open tester slot.

## Deploy

Vercel project `modex`, team `0xbuns`. **Use the repository root**, so deployment includes both
`api/release.js` and the static site. Git deployments use the committed `vercel.json` to install
only the site workspace and root development tools, build with `npm run site:build`, and serve
`apps/site/dist`. They do not compile the native desktop helper on Linux.

For a verified manual deployment, from the root:

```sh
vercel link --yes --project modex --scope 0xbuns
vercel pull --yes --environment=production --scope 0xbuns
vercel build --prod --scope 0xbuns
vercel deploy --prebuilt --prod --scope 0xbuns
```

The former static-only `prepare-vercel.mjs` deployment is removed because it omitted the API.
After deploying, verify `/api/release`, current download links, GitHub counts, TestFlight
buttons and mobile layout. `.vercel` is local and ignored. The public custom domain is
<https://modex.codes>, attached to project `modex` under `0xbuns`. Canonical and social
metadata use this address. The Vercel alias <https://modex-0xbuns.vercel.app> remains available.

## Asset sources

- `workflow-approval.png` and `workflow-complete.png`: unchanged copies of the real
  `docs/screenshots/04-graphite-approval.png` and `05-graphite-complete.png` captures, also
  present in published tag v0.0.10. CSS crops follow the same scripted CONTRIBUTING.md task.
  These demonstrate the app, not live Claude/Codex inference. The original images remain
  accessible; the enlargement dialog supports scrolling to inspect small details.
- `desktop-*.png`: earlier real Modex demo captures at 2760×1760; generated with
  `electron . --demo --screenshot=<directory> --demo-answer=yes` on 2026-10-05.
- `iphone-*.png`: real 1206×2622 simulator captures from Modex Companion build 4, using
  the isolated demo pairing fixture. These illustrate the workflow, not public availability.
- `modex-mark.png`: the unmodified official logo supplied by Val.
- `modex-icon.png` and `social-preview.png`: generated from the official mark with
  `swift scripts/brand-assets.swift`; see `docs/branding/README.md`.
- Manrope is self-hosted from `@fontsource-variable/manrope`; its OFL license is included at
  `/licenses/manrope.txt`.

No personal account, real repository content, pairing code, or credential is shown.
