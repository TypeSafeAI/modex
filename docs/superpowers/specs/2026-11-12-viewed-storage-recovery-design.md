# Viewed storage recovery

Restore the existing C65 promise that Viewed marks survive successive toggles for the current renderer session when localStorage rejects writes. The reproduced #506 follow-up loses mark A after marking B; an unmark can also resurrect stale persisted marks. This repair follows the accepted local-only Viewed decision and does not create GitHub writes or change activation.

A storage-object-scoped WeakMap will hold the last unsaved document after a failed write. Reads use that document until a later successful write persists accumulated changes and removes the fallback. Existing account/repository/PR/revision separation and 200-PR/3000-path bounds apply unchanged. A fresh storage object cannot see an unpersisted session; renderer restart may lose unsaved marks. Cross-window convergence during storage failure is not promised, and the next successful local toggle uses this renderer's pending state.

Passing the current React array into every toggle is smaller but would lose the fallback on remount and duplicate revision ownership in the view. Always caching storage would hide ordinary external storage updates. Cache only failed writes, and clear after success, to preserve the normal storage read path. This is an implementation choice under the authorized repair scope, not a new product decision.
