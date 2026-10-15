# Images and Plugins implementation ledger

Implemented in the owned `images-plugins` worktree and reconciled with `origin/main`
at `f52e033`, retaining Analytics, the Fable credit fallback, the Notes migration and the
Notes workspace tree. This feature is unreleased.

## Delivered

- [x] Typed contracts, isolated main/renderer modules, dedicated rail destinations, Store/iPhone capability gates.
- [x] Native Claude/Codex plugin inventory, discovery, sources/local import, supported lifecycle/configuration commands, scopes, refresh, stale-cache display, complete available skill text and filters.
- [x] Owned image originals/thumbnails, bounded validation, picker/drop/paste, search/project/provenance filters, favorites, trash/protected deletion and export.
- [x] Chat attachment save/reuse, Space insertion with revision checks, and portable Markdown asset export.
- [x] Explicit native skill bindings, normal CLI runner execution/approvals, scoped byte-validated output registration, prompt revisions and ancestry.
- [x] Durable queue/drafts, one active job, cancellation, explicit retries and interrupted startup recovery without replay.
- [x] Independent spec and quality review. Queue write admission, recovery Quit persistence, plugin process termination and request-draining fixes addressed.

## Architecture decisions

- Native plugins use each runtime's shared CLI identity/home. App-owned account sign-in does not create isolated plugin homes. Project/local scopes are shown only when supported; image bindings require user scope because jobs use isolated workspaces.
- No direct inference API. Native plugin commands use detected CLI support; secrets/configuration travel through stdin. Commands needing interactive source trust remain CLI-only.
- Plugin mutation and new turns share admission protection. Persisted per-runtime revisions prevent resuming a stale plugin session; users start a new chat.
- Corrupt image metadata preserves original data and keeps Chat usable. Active generation blocks update restart.
- Rejected queue persistence never admits generation. Cancellation stops execution even if persistence fails.

## Additional deletion patch

The installed Modex 0.0.12 still routes owner removal through the runner restart hold.
The baseline already includes #209 (`6009226`), which replaces that with a dedicated
owner-removal hold: only the target turn stops, while unrelated turns continue.
A new real Electron regression exposed a second race with pending main-process requests.
Deletion now fences new admission, waits up to 15 seconds for admitted requests, then
runs the existing draft preparation/adoption transaction. Timeout or renderer replacement
releases the reversible hold without deleting owners. App restart remains strict.

## Verification

- Full `pnpm build`, desktop main/renderer typecheck and `pnpm test` passed on the
  integrated implementation: 1,534 passed, 16 platform-specific skips, no failures.
- Focused feature/deletion, Analytics and Composer recovery Electron flows: 13 passed.
  Companion pairing and ordinary shutdown passed separately. New delayed/rejected image
  draft-save close regressions: 2 passed.
- Plugin shutdown regressions use real TERM-resistant leaders/descendants and verify
  that mutation admission remains fenced until process teardown completes. The focused
  plugin suite passes 25 tests, including late local-import continuation rejection.
- Independent final review found plugin subprocess shutdown and ordinary-close image
  draft persistence gaps. Both were fixed and approved on scoped re-review.
- Notes/image insertion and reference protection, Space resizing and updater recovery passed
  12 focused Electron checks. The updater test also asserts image prompt bytes after partial
  drain, vetoed Quit and final Quit (2 tests passed).
- Final CI-parity E2E passed with Knowledge opt-in enabled: 307 desktop tests and
  7 site tests, with zero failures. The site suite used its supported port override after
  another process occupied the default port.
- Earlier local shutdown stalls did not reproduce in the fresh Companion/relaunch runs.
  A superseded full run was intentionally stopped after 95 passes to integrate review fixes.
  One final-unit attempt hit `kill EPERM` in unchanged Knowledge cleanup; its isolated
  11-test recheck and the subsequent complete unit rerun passed without code changes.
- Notes workspace-tree integration passed independent review: page IDs, revision checks,
  image references, navigation and capability gates remain compatible.
- GitHub checks passed on `e898519` before the subsequent Notes workspace-tree merge;
  required CI must pass again on the integrated head before landing.
- Screenshots of the Images and Plugins surfaces were inspected during implementation.

The Electron launch helper observes native paint plus visible, settled native/renderer
geometry. A direct probe showed Electron 44 painting and making showInactive windows visible
without emitting `show`; readiness is not inferred from visibility alone.

## Release acceptance still required

Deterministic image fixtures exercise real approval, registration and persistence paths,
without provider calls. They are not proof of live plugin installation, provider authentication,
paid generation or image quality. Live Claude/Codex plugin/generation acceptance, human
keyboard/VoiceOver acceptance, and signed/notarized packaged release verification remain
separate gates. The installed application has not been replaced.
