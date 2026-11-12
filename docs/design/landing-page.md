# Modex landing page

## Intent

Show how Claude Code and Codex fit into a Mac workspace, follow a concrete task, and
make installation predictable. Since 2026-11-12 the page wears the desktop app's default
graphite appearance, so the site and the first screen of the app read as one product.

## Design

- Values come from the app's graphite theme (`apps/desktop/src/renderer/tokens.css`): window
  `#1b1b1c` around a content sheet `#0f0f11`, surface `#202022`, ink `#e3e4e6`, secondary
  `#c4c4c8`, muted `#a3a3a8`, lavender accent `#a89bd8`, rules `#29292c`. Pink stays in the logo.
- The app's system sans stack for headings and reading (semibold, tight tracking), monospace
  for labels, file names and steps. No font files.
- The hero is the app's welcome workspace: the logo on its raised tile, a lavender monospace
  label, the promise, a light primary download with the app's pressed-edge shadow, and the four
  work modes (Chat, Agent, Plan, Full access) as cards with the app's icons, above its shortcut
  hints. "Try the demo" opens the browser demo at `app.modex.codes`; the note beside it says the
  demo is simulated. Cards, setup steps and the download bar reuse the app's card gradient,
  hairline border and shadow. Lavender marks labels, icons and the selected step's number.
- A CONTRIBUTING.md task supplies the request, proposed patch and approved diff. Captures
  come from the actual scripted app demo; they do not claim live provider inference.

```
Navigation / Get started                       (window frame)
[logo tile, promise, requirements]   Choose how you work
[Download / Try the demo / workflow] [Chat] [Agent]
[signing / release / MIT]            [Plan] [Full access]
            ⌘N new chat · ⌘⏎ send · ⇧⌘P plan

One task: Start → Review → Approve   [manual controls + enlarged capture]
Agent choice / worktrees / Pages and Knowledge, with examples
Three setup steps / download
Optional iPhone / same-network and awake-Mac requirements
Inline FAQ / final download
GitHub / license / Jev / community counts
```

## Responsive behavior and access

The page scrolls at every size. Mobile and short windows retain the product explanation,
platform requirements and setup content. Workflow buttons are at least 44px high and never
advance automatically. Pointer and keyboard selection update the description politely.
Reduced motion disables transitions and smooth scrolling.

Screenshot links open a native dialog with a scrollable, readable-size desktop image. Escape
and Close restore focus to the trigger; the image viewport is keyboard-focusable. Original
images are linked directly when JavaScript is disabled. FAQ uses native details elements,
and download, setup and repository links do not depend on JavaScript.

## Delivery and evidence

- Isolated `apps/site` Vite build with root-relative assets and the existing cached release API.
- The verified static download fallback is v0.4.0 (`apps/site/release.json`); valid newer public metadata updates all
  download links and version labels together. Unknown counts remain hidden in the footer.
- Apple silicon and macOS 13 requirements match the published v0.3.0 app's Info.plist.
  Provider access and costs are separate from the free MIT-licensed app.
- Companion uses the approved public TestFlight invitation; tester availability is controlled
  by Apple. The nearby copy states same local network, awake Mac, and running Modex.
- Val confirmed `modex.codes` as the public domain on 2026-10-11. DNS, HTTPS and its
  Vercel project binding were verified; canonical and social metadata use that address.
- See [implementation verification](../reviews/2026-10-11-landing-clarity.md) for checked
  behavior and remaining launch gates.
