# Approval guard recovery

Recovered the 17-file patch from #174 (`554235d4`) into an isolated worktree,
preserving the original branch and its artifacts. The recovery includes main
`5085349` and updater integration `3d43103`.

An allow rule now asks for a human when the full command contains compound shell
syntax or the digest omitted text needed to judge the action. This also applies to
Always allow threads; explicit YOLO behavior is unchanged. Receipts and previews
explain the downgrade and distinguish cases where Jev was not consulted.

Verification on October 12, 2026:

- Full monorepo build and all workspace typechecks passed.
- Full unit suite: 1,376 passed, 15 skipped, no failures.
- Desktop E2E: all 271 cases passed in 9.2 minutes, including the recovered
  chained-command regression. All seven site cases passed.
- The E2E run used Node 24.18.1, CI mode, real Open Knowledge enabled and one
  worker. All 635 source hashes held during the run. All 1,398 observed owned
  process identities and 130 logged fixture path strings were absent afterward.
- Reconciliation with the signed updater head changed only three reviewed docs;
  application, test and build inputs stayed identical to the passing run. This
  receipt and its status link were added afterward.

The approval gate remains off by default. The historical quoted-test-name false
allow remains open; this recovery does not claim a fresh live-model evaluation,
signed installed acceptance, or production approval to enable the gate.
