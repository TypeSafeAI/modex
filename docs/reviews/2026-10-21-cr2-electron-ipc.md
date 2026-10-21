# CR-2 AC1: production Electron IPC, 2026-10-21

The original `test/code-review-ipc.test.ts` captures a compiled handler in a VM and calls it directly.
It proves handler registration options and service/transport behavior, but bypasses Electron IPC.
The additional `e2e/code-review-ipc.spec.ts` covers that missing acceptance boundary for #321.

The test launches the built development app with its production preload, `ipcMain` registration,
read service and subprocess transport. A synthetic `gh` executable answers fixed fixture endpoints;
no IPC handler is replaced and no service function is called directly by the test. `MODEX_E2E`
is unset so this service is enabled. The app home, GitHub configuration and local checkout are
throwaway; GitHub token variables are removed. No external GitHub request or coding turn is made.

Observed assertions:

- Renderer `window.modex.invoke` reads connection → inbox → overview → revision-bound files.
- Two repositories with PR #73 retain distinct stable repository keys and titles.
- Files retain their requested revision; text and omitted binary patches remain distinct.
- A key for another account is rejected as signed out. A malformed PR number is rejected.
- The synthetic executable receives only the expected read endpoints.
- The local checkout retains its HEAD, branch and clean tracked/untracked status.

The focused Electron test passed. Removing only the production channel registration in compiled
output made the test fail with no registered handler; the original output was restored in `finally`.
The mutation log and trace are retained outside the worktree under
`Codex/artifacts/modex-land-and-prune/cr2-ipc-mutation*`. Final build, typecheck, unit and restored
focused-test results belong to the acceptance PR's exact head.

Independent review found no material findings. Hostile-sender rejection and delayed account-switch
races remain covered separately by the existing guard and service tests. This test does not replace
the authenticated smoke evidence, prove a remote diff UI, or complete Code Review Gate A.
