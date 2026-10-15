# Claude Agent SDK app captures

Captured from the running Electron app on macOS on 2026-10-15, from implementation
commit `119962194125dcdbd9a74bb4f0dd88573c89a712`.

The app uses the shipped Claude Agent SDK with the local executable fixture in
`apps/desktop/e2e/fixtures/sdk-cli.cjs`. These are real UI captures of approvals,
withdrawal, graceful Stop and CLI failure handling. The fixture writes only to a
throwaway test project. No live model was used; installed-Claude acceptance was
blocked by the account's weekly usage limit.

- `01-approval-request.png`: pending approval after the corresponding tool row.
- `02-approved-command.png`: approved command and the resulting file change.
- `03-withdrawn-approval.png`: withdrawn request answered no while the turn continues.
- `04-stopped-turn.png`: the thread is idle after the SDK interrupt and process exit.
- `05-cli-error.png`: CLI stderr shown with Retry, Copy details and Details.
