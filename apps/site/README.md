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
`output` directory; it preserves the project link. There is no automatic Git deployment.
After deploying, verify the public HTTPS host, workflow buttons, mobile layout, and download
links. Val manages the `modex.build` custom-domain and DNS setup in Vercel manually. The
public deployment remains available at <https://modex-0xbuns.vercel.app> during setup;
canonical and social metadata point to `https://modex.build/`.

## Asset sources

- `desktop-*.png`: real Modex demo captures at 2760×1760; generated with
  `electron . --demo --screenshot=<directory> --demo-answer=yes` on 2026-10-05.
- `iphone-*.png`: real 1206×2622 simulator captures from Modex Companion build 2, using
  the isolated demo pairing fixture. These illustrate the workflow, not public availability.
- `modex-icon.png`: the shipped icon from `docs/branding/modex-icon.png`.
- `social-preview.png`: existing repository artwork from `docs/branding/`.
- Manrope is self-hosted from `@fontsource-variable/manrope`; its OFL license is included at
  `/licenses/manrope.txt`.

No personal account, real repository content, pairing code, or credential is shown.
