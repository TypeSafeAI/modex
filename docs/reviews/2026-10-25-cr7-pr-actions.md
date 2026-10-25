# CR-7: state menu, edits and reviewer requests through the gh login

#326, third increment: decisions 2–4, put in scope by Val on 2026-10-25. Base: `main` at `a10fcc4`.
Stacked on #414 (`cr7-merge`). Branch `cr7-pr-actions`.

## Change

- **Model** (`intents.ts`): `state`, `edit` and `reviewers` operations.
  - The shared contract's `PrAction` type, imported so the two can't drift.
  - No draft; the data is in the digest.
  - An edit carries the text it replaces.
- **Contract:** `prepare-action`, `parseAction`, and the refusals `state-conflict`, `edit-conflict` and
  `reviewer-invalid`.
- **Transport:**
  - `PATCH pulls/{n}`, whose body may hold only `state`, `title` and `body`;
  - `POST pulls/{n}/requested_reviewers`, with only `reviewers`;
  - `POST graphql`, accepting only GitHub's two draft mutations, text for text, with a node id as the
    only variable;
  - no DELETE.
- **Service:**
  - permission per action, read now: push, triage or authorship as GitHub grants it;
  - state transitions only from the states GitHub allows;
  - an edit refused if GitHub's text changed;
  - no reviewer requests to the author or oneself;
  - outcomes and read-back as for the other writes.
- **UI:**
  - the header's state pill is a keyboard-operable menu;
  - "Edit pull request" opens a title-and-description form;
  - "Request reviewers" takes logins;
  - each change is previewed and confirmed, and the PR is read again afterwards and after a conflict.
- `capabilities()`: `edit`, `request-reviewers` and `state` follow the connection.
- Docs: the control inventory (C21, C29, C31, C35, C38, C43), D7 and D10, and the decisions list. C29 and
  D10 also correct #414's leftovers.

## Validation

Everything below is mock or synthetic `gh`. **No live action was run** on any real PR.

- **Red first** (`test/code-review-intents.test.ts`): the new model test failed before the model change
  (1 of 33). It passed after, with the malformed-operation test alongside.
- **Unit** (`test/code-review-writes.test.ts`, 7 new tests):
  - exact requests;
  - the PATCH, reviewer and GraphQL allowlists, with DELETE refused;
  - close → reopen → draft → ready, each previewed and sent once, with invalid transitions refused and
    a merged PR frozen;
  - permission: reader denied, author allowed, unreadable refused, withdrawn between preview and send;
  - an edit conflict at preview and at submit sends nothing, and only changed fields are sent;
  - reviewer rules (author, self, 422, reader);
  - a 502 after GitHub applied it → unknown → busy → reconcile confirmed;
  - a lost change stays unknown → abandon;
  - GraphQL errors are refused;
  - a moved head sends nothing.
- **Static guard** (`test/code-review-write-ipc.test.ts`) pins:
  - the POST, PUT and PATCH allowlists;
  - two fixed GraphQL mutations;
  - the PATCH keys;
  - the call counts per method;
  - no DELETE, labels, assignees or team reviewers.
- **Electron** (`e2e/code-review-actions.spec.ts`, 4 new tests):
  - the state menu: Escape closes it; close (with a double click), reopen and convert to draft, each
    sent once, with the pill following;
  - an edit refused because the description changed on GitHub, then the PR re-read and only the title
    saved;
  - reviewers: denied without triage, self refused, two logins requested, and shown on the PR;
  - a 502 on close stays in doubt, blocks the composers, and *Check GitHub* confirms it.
- All 79 Code Review Electron specs pass.
- A CSS class collision (`.cr-menu`, already the inbox header's) failed the 900×600 layout check. It was
  caught and fixed by renaming the new classes.
- **Full run** (`pnpm build && pnpm test && pnpm test:e2e`): exit 0.
  - Desktop unit: 1,978 passed, 17 skipped. Other unit suites: 180 passed, 5 skipped.
  - Desktop E2E: 464 passed, 7 skipped (17.5 min). Site E2E: 7 passed.

## Open

- A live run against a disposable repository Val names.
- GitHub has no precondition on a PATCH, so an edit made on GitHub in the moment between main's check and
  its PATCH would still be overwritten.
- Reviewer requests can't be withdrawn, and team reviewers aren't offered.
