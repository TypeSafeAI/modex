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
  They do not create or overwrite page revisions. Opening a note from chat clears
  the previous page's selection while retaining its quoted draft. Page changes
  replace the document and comments panel without leaving an old document mounted.
- Floating chat retains the mounted composer and draft. Workspace shortcuts return
  to the main chat, and global dialogs remain above the floating view. The native
  Knowledge guest hides while floating chat is open and returns when chat minimizes.
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
- `npm test` passed: 470 tests, with one opt-in Open Knowledge unit case skipped.
- `MODEX_TEST_OPEN_KNOWLEDGE=1 npm run test:e2e` passed: all 168 desktop cases,
  including real Open Knowledge integration, and all seven site cases.
- `git diff --check` passed. Independent source review found no remaining important
  blockers.

After integrating the companion shutdown fix from main, build and units passed
again, along with all 12 companion, reference UI, and Space E2E cases.

A further native regression reproduced two page-link defects: duplicate document
nodes from shared sibling keys, and a comment on page B retaining page A's selected
quote. The fixes give comments a distinct key and use the shared page-opening reset.
The regression now verifies one document, an empty persisted quote on B, and A's
retained quoted draft. It and the Space reference case passed; the unchanged chat
hover case timed out after its screenshot and passed its single focused rerun.
All three reference cases passed across that sweep and rerun. Renderer build and
workspace typecheck passed. Final CI repeats the combined tree before landing.

The real Open Knowledge lifecycle test also reproduced the native guest remaining
visible above floating chat. Gating the guest by chat visibility fixed the regression:
the guest hides, the composer remains editable, its draft survives navigation, and
minimizing chat restores the guest. The full real Knowledge case passed in 48.9 seconds.
The final main sync changes only workflow and documentation files.

Editor focus corrections, including placing the Code insert caret inside its
fences, remain in the separate [Space focus PR #170](https://github.com/TypeSafeAI/modex/pull/170).
