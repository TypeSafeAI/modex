# CR-7: comments and reviews through the gh login

#326. Base: `main` at `a10fcc4`, stacked on `cr7-anchors` (#410, `56691ab`). Branch `cr7-write-submit`.

## Decision

On 2026-10-25 Val answered the two questions on #326:
- writes are authorized through the person's own `gh` login, not a GitHub App;
- decisions 2–4 (the state menu, title and description edits, reviewer requests) are in scope.

`AGENTS.md` records the approval and its limits. This is the first of three increments:
1. draft and submit (this PR);
2. a merge that passes the reviewed head SHA and offers only the methods the repository allows (the pure
   preflight is #412);
3. decisions 2–4.

## Change

- **Contract** (`src/shared/code-review-write.ts`): the `code-review:write` requests, replies, fixed
  refusal texts and `validateWrite`. No request carries a session, permission, endpoint or credential.
- **Transport** (`code-review-actions/write-gh.ts`): an allowlist of six GET shapes and two POST
  endpoints. The body goes to gh on stdin, and the environment is the read path's.
- **Service** (`code-review-actions/write-service.ts`): drafts, preview, submit, reconcile and abandon
  over `ReviewActions`.
  - Main re-reads the account, the repository's permission and the PR itself before a preview and again
    before sending, plus the compare for base-side anchors.
  - It requires gh's login state to be unchanged before dispatch.
  - Operations on one PR run one at a time.
- **Main** (`src/main/index.ts`): `localOnly`. The session is `w<sender>-<document epoch>`, so another
  window or a reload can't use a preview. Disabled in demos, under `MODEX_E2E` and in browser
  development.
- **Model** (`intents.ts`):
  - an `abandoned` reason;
  - bounded pruning of settled receipts and empty drafts, which never touches a PR with a send in doubt;
  - `earlier()` for drafts of an earlier revision.
- **UI**:
  - comment and review composers under the activity, each with a preview naming the account,
    destination and head;
  - *Comment on this line* in Changes;
  - for a send in doubt, *Check GitHub* and *Stop tracking*.
- `capabilities()`: `comment` and `submit-review` follow the read connection. Main still decides each
  PR at preview.

Design: [CR-7 writes](../design/code-review.md#cr-7-writes-comments-and-reviews).

## Validation

Everything below is mock or synthetic `gh`. **No live write was run.** There is no disposable
repository authorized by Val yet, and no real PR, comment or review was created.

- **Unit** (`test/code-review-writes.test.ts`, 11 tests) with a fake GitHub transport covers:
  - the contract and transport allowlists;
  - comment local → preview → submit, with the marker;
  - a double submit and a second window, each sending once;
  - refusals for unreadable, missing and locked permission;
  - account, head and target rechecks, and a login change mid-submit;
  - a review pinned to the head, self-review refusal, and an outdated base anchor;
  - a denial that keeps the draft;
  - a timeout → unknown → busy → reconcile confirmed;
  - a crash and restart → unknown → reconcile absent → abandon;
  - drafts per account and head, and carrying a body;
  - disabled mode, and no token text in any reply.
- **IPC** (`test/code-review-write-ipc.test.ts`) runs the compiled main handler with the real gh
  transport and the synthetic gh. It covers:
  - `localOnly`, and refusal without an IPC event;
  - `no-preview` from another sender or after a reload;
  - exactly one POST, on an allowed endpoint;
  - a static check of the write path: allowed imports only, no PATCH, PUT, DELETE, GraphQL or merge,
    exactly two POST sites, and no `process.env` or token.
- **Electron** (`e2e/code-review-actions.spec.ts`, 5 tests) through the production preload, IPC,
  service and gh transport, counting every POST the synthetic gh received:
  - a draft survives a reload; the preview names `ada-fixture` on `example-org/lending #73` at head
    `cccccccc`; a double click posts once.
  - a review with a line comment from Changes posts `commit_id` = head, `RIGHT` line 2; Approve and
    Request changes are disabled on one's own PR.
  - a 403 shows fixed text, keeps the draft and hides GitHub's message. A head move between preview
    and submit is refused with no POST.
  - SIGKILL during a held POST that GitHub recorded: the app restarts in doubt, blocks new sends, and
    *Check GitHub* confirms the send from a read-back. One POST in total.
  - a 502: *Check GitHub* finds nothing and says that proves nothing. *Stop tracking* re-enables the
    composer, keeps the draft and sends nothing. One POST in total.
- The Electron run caught a real bug, which is fixed: the debounced draft save used the text from the
  render before the last keystroke.
- **Full run** (`pnpm build && pnpm test && pnpm test:e2e`): exit 0.
  - Desktop unit: 1,955 passed, 17 skipped, 0 failed. The other unit suites: 180 passed, 5 skipped.
  - Desktop E2E: 456 passed, 7 skipped (17.6 min). Site E2E: 7 passed.

## Open

- A live write against a disposable repository Val names.
- Merge (increment 2) and decisions 2–4 (increment 3).
- The intent marker is visible in the Markdown source of the posted text.
- A read-back matches a review's body, author and head, not each of its line comments.
