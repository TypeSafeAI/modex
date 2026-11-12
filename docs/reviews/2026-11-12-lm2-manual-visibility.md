# Manual local-model IDs after metadata failure

This follow-up to #498 repairs a renderer omission affecting #378 and #381. Main already returns safe manually entered model descriptors when its metadata request fails. The renderer discarded every unavailable result, hiding those IDs in Settings and the model menu. It now consumes main's returned descriptors regardless of discovery state. It never reconstructs descriptors from saved profile IDs.

An IPC rejection supplies no new main-authorized listing. That path now clears cached descriptors instead of carrying a prior successful listing into an unavailable result. If a saved credential cannot be read, main returns no descriptors and performs no HTTP request; the renderer continues to display none. No inference, credential handling, destination policy or execution admission behavior changes.

## Candidate and validation

The owned `lm2-visibility` worktree starts at protected main `5f1f1fe8bfa93ee971de7b443f794335ae9c414e`. Canonical unit tests failed before repair for the missing manual ID and retained descriptors after rejected IPC. The credential-unavailable negative control passed before repair. A production Electron test failed at the absent manual model row in Settings; its original trace and assertion are retained privately.

After repair, all eight focused unit tests passed with no failures or skips. Nine production Electron cases passed with no failures or skips: three new metadata IPC cases, existing authenticated discovery/security coverage, the manual-row regression, and four existing local-model UI cases. The new rendered regression verifies Settings, the model menu, refusal of an attempted local selection, no retained local thread, and only metadata GET requests to its synthetic loopback server. The delayed IPC case switches between two owned endpoints and proves the old revision is stale and its late model never appears. It does not use a label-only edit as an execution-identity change.

Full repository build, typechecks and units passed: 2,474 unit passes, 36 skips, zero failures or cancellations. The full `pnpm test:e2e` command passed with 515 desktop cases, 11 explicit skips and seven site cases; both final result records report no failed tests. Exact signed delivery identity and protected hosted checks must be recorded before claiming this candidate delivered. Independent review found no Critical or Important defects; its Minor fixture-launch cleanup finding was corrected by putting launch inside the server's cleanup boundary.

## Earlier requirement reconciled on main

Implementation step 6 of #378 is supported by the actual #498 merge: Settings explains metadata-only checks separately from first-message cold loading, and its production Electron fixture records only fixed metadata GETs during add/list/Refresh/remove. The protected queue run `43127440657` passed with 2,471 unit passes and 36 skips, 514 desktop E2E passes and eight skips, and seven site passes. All 24 source hashes from the earlier criterion audit match the merged tree. The explanation step alone was ticked with a [source-linked receipt](https://github.com/TypeSafeAI/modex/issues/378#issuecomment-6811762266); #378 remains open. This reconciliation does not deliver the manual-visibility follow-up or establish all other ticked criteria anew.

## Acceptance limits

All servers and locked-credential stimuli in these regressions are synthetic. Electron uses actual production preload, IPC handlers and model services; the tests do not perform model inference. Execution remains unadmitted. These results do not establish real Keychain acceptance, offline coding compatibility, physical-device or human acceptance, or completion of all #378/#381 requirements. No issue checkbox or closure follows solely from this repair.

Original failures, traces and successful logs are retained under `/Users/buns/Documents/Codex/2026-11-11/modex-closeout/`: `lm2-canonical-first-red.log`, `lm2-rendered-first-red.log`, `lm2-rendered-first-red-artifacts/`, `lm2-canonical-focused-green.log` and `lm2-canonical-focused-e2e.log`. These local receipts support this candidate and are not portable public artifacts.
