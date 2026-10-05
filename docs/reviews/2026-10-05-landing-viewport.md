# Landing viewport verification — 2026-10-05

## Scope

The landing shell and walkthrough fill the browser width and dynamic viewport height.
The hero, primary Mac/iPhone actions, GitHub counts and footer fit without page scrolling.
Device images scale to the available stage. Short screens reduce supporting copy and use
Play walkthrough to expose all three stages. Supporting benefits, iPhone, download and FAQ
content remains available in a native details dialog with internal scrolling.

This record covers local validation of the viewport revision. It does not attest to a
production deployment.

## Browser evidence

- Site browser suite: all five checks pass, including current/future release links, offline
  fallback, cached counts, and direct Mac/TestFlight navigation with JavaScript disabled.
- At 320×568, 375×667, 390×844, 768×1024, 1024×768, 1440×900, 1920×1080, 844×390 and
  667×375, document dimensions equal viewport dimensions. Primary actions and footer remain
  inside the viewport, and hero content stays between the header and footer.
- The walkthrough fills both dimensions without internal overflow. Escape restores the
  Play button's focus. Get Modex and About Modex open the details dialog; its TestFlight
  link is reachable, Close restores focus, and Escape dismisses it.
- Additional browser checks at 320×480 and 640×360 keep the hero and controls in the main
  area. Desktop, portrait and landscape captures were visually reviewed, along with the
  iPhone details and mobile walkthrough. Captures are in ignored `output/playwright/`.
- These are automated browser and visual checks, not human VoiceOver acceptance.

## Repository checks

- `npm run build`: passed.
- `npm test`: 286 passed (15 core, 260 desktop, 1 browser bridge, 10 site).
- `npm run typecheck`: passed; site typecheck repeated after the final navigation changes.
- `npm run test:e2e -w @modex/site`: 5 passed.
- Full `npm run test:e2e`: 105 passed (100 desktop, 5 site).
