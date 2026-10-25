# Working in this repository

These rules apply to every session — a person in a terminal, Claude Code, Codex, or Modex
itself driving one of them.

## One worktree per session

- **Never edit in the primary checkout.** It stays on `main` and only ever receives
  `git pull`. Each session gets its own worktree under `.worktrees/<name>` on a branch of
  the same name, cut from `origin/main`:

  ```sh
  scripts/worktree.sh new <name>      # prints the worktree path; cd into it
  scripts/worktree.sh check           # exits 1 if you are still in the primary checkout
  scripts/worktree.sh remove <name>   # after the PR merged
  ```

  Pick a short slug for `<name>` that says what the session is doing (`thinking-item`,
  `fix-scroll`, `ci-macos`). `.worktrees/` is git-ignored.
- Two sessions must not share a worktree or a branch. If you find commits you did not make
  on your branch, stop and reconcile before pushing.
- `new` claims ownership. Before resuming a legacy or released worktree, run
  `scripts/worktree.sh claim <name> --owner <session>` and then `check`.
  Claims never expire by age. When finished, save evidence outside the worktree, end its
  session, and run `scripts/worktree.sh release <branch> --expect-head <full-SHA>`.
  Only the owner may release its work. Unknown, active, dirty, and uncertain work stays.
- Use the [pruning procedure](docs/worktree-hygiene.md). `remove` and the daily installed
  job require fresh merge proof and a verified recovery bundle before deleting local work.
  Do not bypass this with force removal, branch force-deletion, or manual directory deletion.
  `scripts/worktree.sh audit` reports eligibility; `schedule status` reports the local job.
  These tools never delete remote branches or recovery archives. GitHub deletes a PR's
  branch itself when the PR merges (`delete_branch_on_merge`, on since 2026-10-15) and moves
  PRs stacked on it to its base, so put follow-up work on a new branch.
- Modex's own worktree threads (`⑂`) honour this convention: when a project ships
  `scripts/worktree.sh`, Modex calls `new modex-<thread id>` / `remove …` on it, so threads on
  this repo land in `.worktrees/` like any other session. Projects without the script get a
  plain `git worktree` under `~/.modex/worktrees/`.

## Landing changes

- `main` is protected by a ruleset (`.github/rulesets/main.json`): **signed commits** and
  the **`unit + e2e (macOS)`** check are required; direct pushes are rejected.
- Flow: worktree → signed commits (`git commit -S`) → push the branch → PR → CI green → add it
  to the merge queue (squash). The queue tests it on top of `main`, so the branch needn't be up
  to date first. Then `scripts/worktree.sh remove <name>`.
- Install with pnpm (`pnpm install`); `packageManager` in `package.json` pins the version.
  npm and Yarn refuse to run here; any other installer fails at the root `preinstall` guard.
- Before pushing, run what CI runs: `pnpm build && pnpm test` and, for UI changes,
  `pnpm test:e2e`.

## Where things are

- `apps/desktop` — the Electron app (`src/main` process + backends, `src/renderer` React UI,
  `e2e/` Playwright). `packages/core` — the offline scripted engine used by demos and tests.
- `docs/release-signing.md` — how release builds are signed and notarized, and where the
  credentials live (never in the tree). `pnpm --filter @modex/desktop dist` stays ad-hoc for
  everyday builds.
- `docs/status.md` — what has shipped, what is on `main` but unreleased, what is in flight, what is
  next. Update it in the PR that changes any of those. `docs/reviews/` holds release evidence.
- Real models run only through the `claude` and `codex` CLIs. There is no API mode for
  coding turns; do not add one. App-owned Sign in with ChatGPT may make authentication-only
  requests to OpenAI's authorization, OpenID metadata/JWKS, token and revocation endpoints;
  tokens stay in main-process OS-encrypted storage and the account's Codex child environment.
  These calls never carry prompts or files or execute inference. The optional Auto routing
  judge (Jev, `apps/desktop/src/main/engine/routing/`) answers typed questions for Auto
  routing and approval rules; it never runs a turn or sees file contents. Without Jev,
  Auto uses its heuristic and approval rules use only exact matches or ask a human. See
  `docs/auto-routing.md` and `docs/approval-rules.md`.
- Modex account sign-in may make identity-only requests to WorkOS's public authentication
  endpoint and open its authorization/logout URLs. Main owns public-client PKCE and
  OS-encrypted refresh credentials; provider/access tokens are discarded. No prompts,
  files, inference or repository actions use this connection. See `docs/modex-signin.md`.
- Installed desktop builds may fetch public GitHub release metadata for update banners.
  The fixed release endpoint receives only application/version headers; no prompts, files
  or account credentials. Development, demos and tests keep this network check disabled.
- **Approved by Val on 2026-10-24 (#377 / #376):** Main may read bounded model metadata from an explicitly configured loopback connection using Ollama's `/api/tags`, `/api/ps` and metadata-only `/api/show`, LM Studio's model listings, or a compatible `/v1/models` listing. Requests use only that connection's credential, refuse redirects, proxy routing and non-loopback destinations, and carry no prompts, files or cloud-account credentials. Discovery must never generate inference, download/load/unload models or execute tools. Coding inference remains inside `codex app-server` or `claude -p`; discovery proves neither coding compatibility nor offline inference. This exception authorizes only metadata discovery; local execution admission and runtime qualification retain their separate gates.
- **Approved by Val on 2026-10-25 (#326):** Code Review may write to GitHub through the person's own `gh` login, on a separate main-owned `code-review:write` channel that is never `code-review:read`. Main runs only fixed `gh api` mutation endpoints it builds from its own reads (today: a top-level PR comment, a submitted review, and a merge that passes the reviewed head SHA and offers only the methods the repository allows; a later increment adds the state, edit and reviewer controls of decisions 2–4). Before a preview and again before sending, main reads the signed-in account, the repository's permission for it and the PR's head and target itself; the renderer's word, model findings and check counts are never authority. Sends are explicit, preview-bound and never retried on their own; an unclear outcome stays unknown until a read-back proves it or the person decides. Modex never sees or stores the token. Tests use a synthetic `gh`; a live write runs only against a disposable repository Val names.
- Scratch scripts go in `apps/desktop/.probes/` (git-ignored). Playwright wipes
  `apps/desktop/test-results/` on every run.
