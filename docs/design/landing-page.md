# Modex landing page

## Intent

Help developers understand the Mac workspace and iPhone companion, then find the correct
installation route. Keep the existing near-black blue and Jev pink direction.

## Design

- Ink `#f3f1f5`, secondary `#b2b6c6`, canvas `#080c17`, surface `#101625`,
  Jev pink `#f386a1`, quiet lavender `#9386d0`.
- Manrope variable for the large, closely set headline; system sans for body and controls;
  system monospace for small platform/status captions.
- The signature is a dimensional Mac workspace with an iPhone moving forward as the visitor
  selects a real workflow stage. Actual product captures supply the screen content.
- Keep supporting content available through About Modex: three concrete benefits, an
  iPhone explanation, installation details and FAQ.

```
Modex · latest release      [dimensional desktop + phone]
A home for your
coding agents.              [Mac → approval → follow-up, looping]
Mac download / TestFlight   [three persistent step controls]

About Modex                         GitHub / MIT / Powered by Jev
```

## Viewport layout

The landing view occupies the full browser width and dynamic viewport height with no page
header. Branding sits with the hero copy; the product carousel uses the remaining space.
Desktop uses two columns and portrait screens stack the copy above the devices. Short
screens simplify supporting copy but keep all three step controls visible. Devices scale to
their available space rather than increasing page height.

The carousel advances every four seconds and wraps back to the first step. Selecting a step
by pointer or keyboard stops autoplay for the rest of the visit. There is no Play control or
separate playback dialog. Reduced motion disables autoplay, and hidden tabs or open details
temporarily pause it. Automatic updates stay out of live screen-reader announcements.

About Modex opens the supporting benefits, iPhone, installation and FAQ details in a native
dialog. Only that dialog scrolls; Escape and Close return focus to About Modex. With
JavaScript disabled, Mac, TestFlight and repository links remain usable.

## Delivery and evidence

- Isolated `apps/site` Vite static build with root-relative asset paths.
- macOS: cached public GitHub metadata selects the latest stable Apple Silicon release;
  verified v0.0.7 links remain the static fallback.
- iPhone: the approved public TestFlight invitation remains visible. Apple controls beta
  enrollment availability; this is not an App Store listing.
- Use `modex.build` as the homepage and canonical URL. Val handles custom-domain and DNS
  setup in Vercel manually; use the public Vercel alias to verify content during setup.
- Verify desktop/mobile rendering, keyboard access, reduced motion, carousel controls,
  links, and built asset loading. Run repository build, unit and e2e gates before pushing.
