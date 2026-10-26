# CR-7 write integration repair

The repair integrates PRs #413, #414 and #415 on `a10fcc40f6f6ea1bb6689db43decaa29561ddb0d` in the owned `cr7-write-repair` worktree. The integration commit before repairs is `e141aae72536680c8fd6ebde8cfc5315a35bf3c7`. Independent source review found no remaining critical or important issue in the four repaired paths; broader validation and protected delivery remain separate gates.

## Behavior

- Main captures the requesting document epoch before awaiting PATH readiness, checks its authority after per-PR queue admission, and checks again immediately before durable dispatch. Reloaded, destroyed or untrusted senders cannot use a pending submit to mutate GitHub.
- Inline comments require a complete bounded file listing, a stable revision across that listing, and valid supported ranges in complete provider hunks. Base-side commits are checked against the diff base. Renamed base-side paths resolve to GitHub's current filename. The same pure patch parser serves main and the renderer.
- Shared renderer state retains pending draft bodies across composer unmount, serializes their saves, and flushes them on navigation or preview. Account changes cancel pending buffers and fence late replies. Unsaved text is labeled as saving rather than saved.
- Confirmation shows each frozen inline body, destination path, side and line range, in addition to the account, PR and reviewed head.

## Preserved evidence

The reload-during-preflight regression initially returned success where refusal was required. The initial inline-anchor regressions also allowed an invented path and a submit whose patch evidence had disappeared. After repairs, all 32 write-service/IPC tests and nine existing parser tests passed. Renderer type-checking exposed an inherited generic request-cast error; the request is now constructed from the discriminated request union, and type-checking passed.

The navigation E2E regression initially lost the composer before the debounce could save its text. The first preview run stopped at the new completeness guard because the display-density fixture advertised 11 files but supplied two. The writable-review fixture now reports its actual two files; the next run reached the intended failure, missing inline details in confirmation. Both failure traces are preserved externally under `modex-land-and-prune`. The repaired navigation and inline-preview cases passed; all 14 CR-7 action E2E tests passed in 1.6 minutes, with no skips.

The full unit command passed with 2,163 passes, 22 skips and no failures. Six focused draft-buffer/race/IPC tests also passed, including a newer edit during a held save, account clearing during a save and document invalidation while a submit is queued. Full E2E passed: 465 desktop cases with seven skips, and seven site cases with no skips. The five-fresh-launch transcript gate passed without retries at a 208.1 ms median on an Apple M5 Max (samples 210.9, 200.3, 211.8, 204.5 and 208.1 ms; limit 500 ms). This local result does not repair or supersede the older LM-2 hosted performance failure. The signed candidate and protected delivery remain to be recorded before claiming this repair landed. No authenticated live write was performed; that acceptance still requires a disposable repository named by Val. Human/reference acceptance remains open.
