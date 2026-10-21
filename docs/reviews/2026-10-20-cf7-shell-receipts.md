# CF-7 shell receipt verification repair

Related to [#280](https://github.com/TypeSafeAI/modex/issues/280). Worktree
`cf7-check-chain`, based on main `44518f2bb58f106531431ba6f97da41d5350d0ed`.

## Reproduction and change

A successful receipt for `pnpm test || true` or `pnpm test; printf broken > app.ts`
previously marked an edited turn verified. The receipt cannot establish that the test passed,
or that it checked the final contents. The command classifier now accepts only known checks
joined with `&&`, optionally preceded by directory changes. It rejects mixed commands,
redirection, shell expansion and unsupported control flow. Shell wrappers accept only exact
`-c` or `-lc` plus one script; syntax-only options cannot establish execution.

A second regression covered earlier verification remaining current after write-capable commands
such as `env node rewrite.js`, `sort -o app.ts input.txt` and `sed -n 'w app.ts' input.txt`.
Read-only recognition now uses a narrower set. Git status accepts known display flags, sed
accepts numeric print expressions, and ripgrep preprocessing is not read-only. Other uncertain
commands invalidate earlier checks. This can conservatively mark legitimate commands stale.

The footer and exported Note say “no check result confirms the latest changes” when there is
no recognized check evidence. This avoids claiming no check ran inside an ambiguous receipt.
Commands remain visible in the task record.

## Validation

- New shell-control-flow and dynamic-expansion tests failed against the original implementation.
- Review reproduced no-execution wrapper and write-capable read-command gaps; added regressions
  failed before their fixes.
- Focused task-context tests passed: 29 tests, no failures.
- Independent re-review found no further blockers in the shell-control-flow scope.
- `pnpm build` and `pnpm typecheck` passed.
- `pnpm test` passed: 1,973 passed, 16 skipped, no failures across six invocations.
- Full `pnpm test:e2e` exited 0: desktop **376 passed, 6 skipped** (13.2 minutes), then site
  **7 passed** (6.4 seconds). All five task-to-Notes cases passed, including the new renderer
  regression for synthetic masked-failure, write-after-check, pipeline and valid `&&` receipts.
  It does not execute those shell commands.
- SHA-256 readback confirmed all four changed source/test files matched the files validated by
  the full run. Only documentation was finalized afterward.

Logs are preserved outside the worktree under
`/Users/buns/Documents/Codex/artifacts/modex-land-and-prune/cf7-check-chain-*.log`.

## Limits

This classifies reported commands; it does not inspect arbitrary package-script implementations
or establish check relevance to individual plan steps or revisions. Saved-task reopening,
project/step verification associations and the remaining native/human acceptance for #280
remain open. This repair does not close #280 or certify the broader conversation workflow.
