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

Validation was repeated after incorporating the latest Codex permission fix on main.
The workspace build and unit suite passed: 469 tests passed, with one opt-in Open
Knowledge case skipped. All 163 enabled desktop end-to-end cases passed across the
initial sweep and a resumed run of the remaining files. The initial sweep completed
86 passing and three opt-in skipped cases before disk exhaustion (`ENOSPC`) stopped
the runner. After unused npm cache cleanup, all 83 cases in the resumed file set
passed, including six cases repeated from the initial sweep. No application change
was needed for the disk error.

All seven site end-to-end cases also passed. GitHub CI runs the complete desktop
suite, including the opt-in Open Knowledge cases, before protected-main landing.
