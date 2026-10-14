# Modex landing page

## Intent

Show how Claude Code and Codex fit into a Mac workspace, follow a concrete task, and
make installation predictable. Preserve the near-black blue and pink identity.

## Design

- Canvas `#080c17`, surface `#101625`, ink `#f3f1f5`, secondary `#b2b6c6`,
  pink `#f386a1`, borders `#29303f`.
- Self-hosted Manrope for headings, system sans for reading, monospace for file and step labels.
- The hero pairs a concrete promise with an enlarged approval capture. Pink connects the
  primary download, selected workflow step and small section labels.
- A CONTRIBUTING.md task supplies the request, proposed patch and approved diff. Captures
  come from the actual scripted app demo; they do not claim live provider inference.

```
Navigation / Get started
Concrete promise + requirements     [proposed patch]
Download / Explore workflow          [signing / release / MIT]

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
- The verified static download fallback is v0.0.12; valid newer public metadata updates all
  download links and version labels together. Unknown counts remain hidden in the footer.
- Apple silicon and macOS 13 requirements match the installed v0.0.12 app's Info.plist.
  Provider access and costs are separate from the free MIT-licensed app.
- Companion uses the approved public TestFlight invitation; tester availability is controlled
  by Apple. The nearby copy states same local network, awake Mac, and running Modex.
- Val confirmed `modex.codes` as the public domain on 2026-10-11. DNS, HTTPS and its
  Vercel project binding were verified; canonical and social metadata use that address.
- See [implementation verification](../reviews/2026-10-11-landing-clarity.md) for checked
  behavior and remaining launch gates.
