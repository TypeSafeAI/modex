# Chats and Space reference layout

The October 11 screenshot set guided the Graphite chat list, hover details, Space
navigation, page toolbar, insert menu, comments panel, and floating chat. The
implementation retains Modex's real CLI chat and local Markdown operations.

## Visual comparison

Native Electron captures were compared with all five supplied references. The Space
capture uses the reference's 3846 × 2098 physical pixel dimensions. Four sampled
surfaces match exactly: main `#0f0f11`, sidebar `#131315`, comments `#202022`, and
window chrome `#1b1b1c`. The document title's measured ink bounds match within
0.5 CSS pixels. Chat rows stay 30 px tall and the Graphite sidebar defaults to 280 px;
saved widths and pointer/keyboard resizing still apply.

This is not a whole-image zero-difference result. Branding, icons, native window
controls, page content, and available actions differ from the reference application.
Sites and Images filter existing pages, Share copies or exports Markdown, and
Visualize prepares a prompt in the existing chat for review before sending.

## Interaction coverage

- Chat hover details and Right Arrow/Escape navigation preserve row positions and
  focus. Transcript/composer scrolling does not dismiss the card.
- Comments persist locally, preserve drafts per page, and reject invalid writes.
  They do not create or overwrite page revisions.
- Floating chat retains the mounted composer and draft. Workspace shortcuts return
  to the main chat, and global dialogs remain above the floating view.
- The insert menu, page navigation, history, sharing, and editing use existing
  actions. A 900 × 620 viewport check covers the compact comments overlay.

Automated keyboard and DOM checks do not constitute a human VoiceOver acceptance
review. Native pointer movement on the shared Mac can interrupt hover dwell; the
hover tests retry entering the target before asserting that the card appears.

## Validation

The final run includes main's native-window and Knowledge readiness fixes. The
reference capture uses the shared native/renderer resize helper; measured title
geometry is unchanged.

- `npm run build` passed.
- `npm test` passed: 469 tests, with one opt-in Open Knowledge unit case skipped.
- `MODEX_TEST_OPEN_KNOWLEDGE=1 npm run test:e2e` passed: all 168 desktop cases,
  including real Open Knowledge integration, and all seven site cases.
- `git diff --check` passed. Independent source review found no remaining important
  blockers.

GitHub CI repeats build, unit, desktop/browser, site, and iPhone checks before
protected-main landing.
