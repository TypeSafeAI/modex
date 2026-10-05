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
- Keep supporting content restrained: three concrete benefits, an iPhone explanation,
  installation details, and a final download call to action.

```
Modex                         How it works / iPhone / Download
A home for your              [dimensional desktop + phone]
coding agents.               [Mac → approval → follow-up]
Mac download / iPhone coming soon

Your projects / Your choice of agent / Your approval

[phone capture]              Keep the work moving from iPhone
                              same network; Mac runs the agents

Download for your Mac        iPhone coming soon
FAQ                          Source / Release notes
```

## Delivery and evidence

- Isolated `apps/site` Vite static build with root-relative asset paths.
- macOS: verified public v0.0.6 Apple Silicon release and direct DMG link.
- iPhone: user selected an explicit Coming soon state; build 2 is internal TestFlight.
  No App Store or TestFlight download link is shown.
- Publish at `modex.jev.works`, as requested. Vercel CLI is authenticated; the parent
  domain uses external registrar DNS. Verify the final host and HTTPS before completion.
- Verify desktop/mobile rendering, keyboard access, reduced motion, walkthrough controls,
  links, and built asset loading. Run repository build, unit and e2e gates before pushing.
