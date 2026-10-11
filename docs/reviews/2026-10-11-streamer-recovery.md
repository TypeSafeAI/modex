# Streamer Mode recovery — October 11, 2026

Streamer Mode masks recognized credentials while keeping Modex usable. Browser and
Knowledge run in separate native views, so those embedded panes are covered. Chat,
Space notes, settings, file previews, and terminals remain interactive. Pairing QR
codes are hidden; copying a pairing link still returns the original link.

## Original values

Text redaction uses CSS Custom Highlights over the original DOM. Native inputs keep
their original value and mask the whole field when it contains a recognized secret.
Copy/cut handlers preserve selected raw text and native undo. Display attributes and
native option labels are formatted separately; operational URLs and option values
remain unchanged.

Comment inputs use the same original-value masking. Quoted comment excerpts are
masked in full, including public quotes: a selection can omit the credential label
that identified a secret. Dedicated display markers add highlight ranges without
changing selected text, drafts, clipboard contents, or saved comments. Identical
unlabeled text outside comment excerpts still follows ordinary heuristic matching.

The terminal keeps one xterm instance. Its parser, buffer, selection, replies, modes,
and input own the original bytes. Redaction maps buffer cells to painted text,
including wide-character wrap padding, concealed Unicode cells, and multiline keys
whose header has scrolled above the viewport. Toggling does not reset or replay the
terminal.

This replaces the unfinished `streamer-secrets` edit-reconstruction approach and the
released full-window cover. The source worktree and its patch archive remain intact.

## Verification

- Matcher tests cover escaped quotes, Markdown credential labels, YAML block values,
  UTF-16 offsets, token prefixes, headers, URL passwords, and partial streamed tokens.
  A bounded subprocess regression checks large public output with repeated credential
  keywords and decoration. Review probes process eight roughly 240 KB adversarial
  inputs in 2.8–8.8 ms, preserving public text.
- Electron checks passed: native editing, original copy/cut, undo/redo,
  paste, IME composition through CDP, send/relaunch persistence, dynamic text,
  numbered file previews, display attributes, broken-image fallback text, native
  select values, Space formatting/persistence, comment drafts and quoted fragments,
  startup errors, and pairing QR/copy.
- The terminal test verifies actual parser replies, bracketed paste, application
  cursor mode, original selection/clipboard, wrapped credentials, offscreen PEM
  context, and YAML with adjacent public text preserved.
- An independent real-xterm Chromium probe passed seven normal/selected cases:
  wide-character wraps, concealed surrogate and combining prefixes, ANSI with
  visible Unicode, literal separators, YAML, and an offscreen PEM header.
- Inspected Electron screenshots show masking for selected text, native selects,
  wrapped terminal output, multiline terminal secrets, and image fallback text.
- Final combined build and workspace typecheck passed. Unit verification passed 475
  tests, with one optional OpenKnowledge skip. All 175 desktop E2E tests passed with
  real Knowledge enabled, and all seven site E2E tests passed.
- An earlier integration run passed 168 of 169 desktop tests; the remaining
  real-Knowledge installation failed with npm `ENOSPC` during
  a shared disk-space incident. After reclaiming completed test dependencies, that
  unchanged case passed on its focused rerun. Its failed run remains retained.
  The earlier native resize mismatch (647 requested, 468 observed) is covered by the
  shared readiness fix in #167.

Review found and corrected multiline terminal context, line-number gutters, native
select painting, Unicode cell mapping, stale display-attribute restoration, and
image fallback text. Review also reproduced quadratic matching on large public output;
nonoverlapping label matching and literal URL delimiters remove that slowdown. An
initial matcher overmasked public YAML text after a
`-secret` suffix; a regression now keeps that text visible. These failed runs are
retained in the local recovery evidence, rather than represented as passing runs.

## Limits

Detection is heuristic. Arbitrary unlabeled secrets and secrets in image pixels are
outside this boundary. DOM text, clipboard contents, accessibility text, persisted
files, and CLI payloads retain originals. This is visual masking, not data removal.
The automated IME and selection checks are not human IME or VoiceOver acceptance;
no live model-generated coding turn is claimed by this review.

Local evidence is retained under `~/.codex/recovery/modex-20261011/`, including the
independent review, runnable xterm probe, its JSON results, and verification logs.
Screenshots are in the recovery worktree's `apps/desktop/.probes/` directory.

## UI integration verification

The final UI candidate `fd242f2` adds comment inputs, selected excerpts, and floating
chat. Integration preserves Space selection/caret fixes and the native Knowledge
guest gate while chat is open. Two Electron regressions first reproduced an unmasked
comment input (`none` instead of `disc`) and an unmasked value-only quote selected
from `API_KEY=**abcdef**`. With the input wrapper and quote ranges applied, both
passed in 5.6 seconds. They verify full quote coverage, original clipboard and saved
text, retained comment drafts, mode toggles, and identical public text outside the
excerpt remaining visible. Failure traces and hashes are retained under
`streamer-comments-red-results` in the recovery evidence directory.

Final combined build, unit, typecheck, full native/site checks, and independent source
review passed. Review confirmed original values, refs, callbacks, and clipboard
behavior remain intact, and the native Knowledge chat gate composes with Streamer Mode.
