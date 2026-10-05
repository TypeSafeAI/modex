# Landing page verification — 2026-10-05

## Scope

Static Vite site in `apps/site`, with Jev near-black blue and pink, real Mac/iPhone demo
captures in CSS 3D devices, and a three-step interactive walkthrough. The Mac CTA points to
published v0.0.6; iPhone is **Coming soon** as requested. No signup or public beta invitation.

## Browser evidence

- Reviewed desktop at 1440×1000 and a full mobile capture at 390×844.
- Playwright browser checks against the public deployment passed at 375, 390, 768, 1024,
  and 1440 pixels: document width equals viewport width; no horizontal page overflow.
- All three workflow steps and Play/Pause work. Keyboard Enter activates a workflow button
  and the native FAQ disclosure. No console errors or warnings; all screen images load.
- Reduced motion: computed phone transition is `0s` and pointer rig transform is `none`.
- Named section references resolve to existing headings. Download links contain the public
  version, with no unreplaced template placeholders.
- Public GitHub release metadata confirms v0.0.6 is not a draft and includes the arm64 DMG,
  ZIP, checksums, and verification log.
- These are automated browser checks and visual capture review, not human VoiceOver acceptance.

## Hosting

Vercel project `0xbuns/modex`, static Build Output API deployment. Public production alias:
<https://modex-0xbuns.vercel.app>. The project is public so downloads do not require a Vercel
account. The requested custom domain is attached, but external Namecheap DNS is pending:
A record `modex` → `76.76.21.21`. Final DNS/HTTPS verification must follow that change.

Deployment uploads contain built site files only. There is no app runtime, model request,
analytics collection, remote font service, or credential requirement.

## Repository gates

`npm run build`, `npm test` (15 core, 253 desktop, 1 bridge), `npm run typecheck`, and
`npm run test:e2e` (97 passed) completed locally. The site build is part of the root build,
so the existing macOS workflow also compiles the public page. Published HTML and font-license
responses match the local build byte for byte.
