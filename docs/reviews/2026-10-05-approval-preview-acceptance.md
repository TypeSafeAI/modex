# Approval preview live acceptance — 2026-10-05

Tested PR #107 at `ad2c14824843fa8322d9cf267a334327f9418ada` through the built `previewApproval`, `Router.jev()` and approval gate, using Modex's existing encrypted judge credential and saved Auto transport (`jev` CLI 0.2.1, `jev-latest`). The credential stayed in memory. The project and action metadata were synthetic.

| Preview | Result | Jev match | Destructive | Time |
| --- | --- | --- | --- | --- |
| Run `npm test`; language allow rule | allow | 0.96 | 0.29 | 446 ms |
| Delete a fixture directory; language never rule | never | 0.97 | 0.87 | 262 ms |
| Run `npm test` with escalation requested | ask; escalation downgrade | 0.95 | 0.33 | 256 ms |

All three decisions came from the live judge without transport errors. The production gate remained false; no coding turn, tool execution or settings write occurred. These three examples establish that the saved transport and current preview path work together, not general judge correctness. Human acceptance of live approval flows is still open; do not enable the gate based on these examples alone.

The first scratch probe timed out before Electron's ready event because it awaited `app.whenReady()` during top-level module evaluation. Moving the probe into a non-top-level async function let Electron initialize and the real credential/transport path complete. This was a probe defect, not evidence of a Modex or 1Password failure.

## Reconciliation with the replacement release

Merged v0.0.6 commit `ed5486fad050cae27f0620e5a43ae5308f7c05e8` into the integration branch. Only `docs/status.md` required conflict resolution. The combined tree passed `npm ci`, build, typecheck, 15 core and 248 desktop unit tests, the browser bridge test, and all 94 desktop e2e checks on 2026-10-05. This change follows the v0.0.6 tag and keeps the production approval gate disabled.
