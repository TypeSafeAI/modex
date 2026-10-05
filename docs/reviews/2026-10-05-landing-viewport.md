# Landing viewport verification — 2026-10-05

## Scope

The headerless landing shell fills the browser width and dynamic viewport height. Branding,
Mac/iPhone actions, GitHub counts, the carousel and footer fit without page scrolling. Device
images scale to the available stage. All three step controls stay visible, including short
screens. Supporting benefits, iPhone, download and FAQ content remains available in a native
details dialog with internal scrolling.

The carousel loops every four seconds until a visitor selects a step by pointer or keyboard.
There is no Play control or playback dialog. Reduced motion disables autoplay; hidden tabs
and open details pause it temporarily without resetting a manual selection.

This record covers local validation of the viewport revision. It does not attest to a
production deployment.

## Browser evidence

- Site browser suite: all seven checks pass, including current/future release links, offline
  fallback, cached counts, and direct Mac/TestFlight navigation with JavaScript disabled.
- At 320×568, 375×667, 390×844, 768×1024, 1024×768, 1440×900, 1920×1080, 844×390 and
  667×375, document dimensions equal viewport dimensions. Primary actions and footer remain
  inside the viewport, and hero content stays above the footer. All three carousel images/steps fit at each size.
- The carousel advances through every scene and loops back to the beginning. Clicking or
  pressing Enter on a step stops subsequent rotation. Opening/closing details or changing
  the motion preference does not restart a manually selected carousel.
- Reduced motion leaves the initial scene still. Opening About Modex temporarily pauses
  rotation; Escape resumes it unless a step was manually selected. The TestFlight link is
  reachable in the dialog, and Close restores focus to About Modex.
- Headerless desktop, portrait and short landscape captures were visually reviewed. Captures
  are in ignored `output/playwright/carousel-*.png`.
- These are automated browser and visual checks, not human VoiceOver acceptance.

## Repository checks

- `npm run build`: passed.
- `npm test`: 286 passed (15 core, 260 desktop, 1 browser bridge, 10 site).
- `npm run typecheck`: passed; site typecheck repeated after the carousel changes.
- `npm run test:e2e -w @modex/site`: 7 passed.
- Full `npm run test:e2e`: 107 passed (100 desktop, 7 site).
