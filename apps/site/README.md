# Modex landing page

Static Vite/TypeScript site for **https://modex.build**. Uses CSS perspective and a
three-step product walkthrough; no WebGL, analytics, third-party fonts, or backend service.

## Develop and build

From the repository root:

```sh
npm install
npm run site:dev
npm run site:build
npm run typecheck -w @modex/site
```

`release.json` is the published macOS download version. Change it only after verifying the
public GitHub release and its Apple Silicon DMG. The iPhone CTA stays **Coming soon** until
public distribution is approved. Desktop features on unreleased `main` do not change that link.

## Deploy

Vercel project `modex`, team `0xbuns`. Only built static files are uploaded:

```sh
vercel link --yes --project modex --scope 0xbuns --cwd apps/site
npm run site:build
node apps/site/scripts/prepare-vercel.mjs
vercel deploy --prebuilt --prod --scope 0xbuns --cwd apps/site
```

The `.vercel` directory is local and ignored. `prepare-vercel.mjs` replaces only its generated
`output` directory; it preserves the project link. These commands deploy prebuilt files
independently of Git deployments.
After deploying, verify the public HTTPS host, workflow buttons, mobile layout, and download
links. Val manages the `modex.build` custom-domain and DNS setup in Vercel manually. The
public deployment remains available at <https://modex-0xbuns.vercel.app> during setup;
canonical and social metadata point to `https://modex.build/`.

For Git deployments, use the repository root, build command `npm run site:build`, and output
directory `apps/site/dist`. The default root `npm run build` also compiles the macOS desktop
app and is not the site's Vercel build command.

## Asset sources

- `desktop-*.png`: real Modex demo captures at 2760×1760; generated with
  `electron . --demo --screenshot=<directory> --demo-answer=yes` on 2026-10-05.
- `iphone-*.png`: real 1206×2622 simulator captures from Modex Companion build 3, using
  the isolated demo pairing fixture. These illustrate the workflow, not public availability.
- `modex-mark.png`: the unmodified official logo supplied by Val.
- `modex-icon.png` and `social-preview.png`: generated from the official mark with
  `swift scripts/brand-assets.swift`; see `docs/branding/README.md`.
- Manrope is self-hosted from `@fontsource-variable/manrope`; its OFL license is included at
  `/licenses/manrope.txt`.

No personal account, real repository content, pairing code, or credential is shown.
