# Claude account pool

Settings → Coding CLIs → Claude Code manages more than one Claude account. Modex keeps its own pool,
picks the account each new conversation starts on, and moves on when an account hits its usage limit.
This is the same job the multi-subscription routers do (CC-Router, OmniRoute, teamclaude), done inside
Modex without a proxy on the request path. Every turn still runs through the installed `claude` CLI.

## Accounts

| Kind | What Modex stores | What the `claude` child gets |
| --- | --- | --- |
| Claude Code's own login | nothing | the person's environment, unchanged |
| Profile | a label and an id in `app/claude-accounts.json` | `CLAUDE_CONFIG_DIR=app/claude-profiles/<id>` |
| OrcaRouter key | a label, an optional model id, and the key in `app/secrets.json` (OS-encrypted) | `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, optional `ANTHROPIC_MODEL` and tier models |

- **Profiles.** Each profile is a separate Claude Code configuration directory, owner-only. **Sign in**
  runs `claude auth login` in that directory and confirms it with `claude auth status`, exactly as the
  existing Claude sign-in does. Claude Code owns the credential and its refresh. Modex never reads a token.
- **OrcaRouter keys.** Keys must start with `sk-orca-`. The base URL is `https://api.orcarouter.ai`
  without `/v1`, because Claude Code appends `/v1/messages` itself (OrcaRouter's documented rule for
  Anthropic-protocol tools). Model ids use OrcaRouter's `vendor/model` form, or `orcarouter/auto`.
  The key goes to main once, is encrypted with Electron safeStorage, and never crosses IPC again.
  A gateway turn removes inherited `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`, which would
  otherwise win, and sets `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` so Claude Code 2.1.316 strips the
  key from the shell commands the model runs. The key is redacted from any failure text.

Choosing an OrcaRouter account sends that conversation's prompts, files and tool results to
OrcaRouter, which forwards them to the upstream provider. Modex itself makes no request to OrcaRouter.

## Binding and rotation

A Claude thread is bound to the account its first turn ran on, like a Codex thread (`Thread.claudeAccount`).
A profile's sessions live in its own directory, so a resumed conversation must stay on its account.
Claude Code's own login and OrcaRouter accounts share `~/.claude` and can resume each other's sessions.

**Rotate when an account hits its usage limit** is off by default. When a turn fails with a usage limit:

1. The account sits out until the reset time Claude Code printed ("resets at 11pm", "resets Nov 3 at
   7pm", "try again in 2 hours"), read in local time, or for one hour when it gave none.
2. With rotation on, the next account in list order that is not cooling down is chosen. Claude Code's
   own login is the last resort. New conversations start there.
3. The failed turn retries once on that account only if it had not started work (no reply, tool or
   thinking) and either the conversation was new or both accounts share `~/.claude`. Otherwise the
   thread says where new conversations go and keeps its failure card.
4. A completed turn clears its account's cooldown. Cooldowns are kept in memory and reset on restart.

Removing an account clears its key or deletes its profile directory. A thread still bound to it fails
its next turn with a message to add the account again or start a new thread. Removal and sign-in are
refused while a turn on that account is running.

## Limits

- Fixture tests cover storage, validation, the child environment, redaction, rotation and the Settings
  flow (`test/claude-accounts.test.ts`, `e2e/claude-accounts.spec.ts`). They use a synthetic `claude`
  and send nothing to Anthropic or OrcaRouter.
- No live OrcaRouter turn, real second Claude subscription or real usage-limit message has been run.
  The reset-time parser follows wording seen in Claude Code's limit messages and may miss new phrasings.
- Rotating between accounts does not change any provider's usage policy. Check each provider's terms
  before pooling subscriptions.
- OmniRouter (omnilabs-ai/OmniRouter) was evaluated and not integrated. It is a pre-alpha model-swap
  evidence layer that compiles routing policies for an existing gateway. It has no account switching.

## Review repairs

Managed profile turns, authentication checks and login all remove inherited `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_BASE_URL` before selecting the profile's configuration directory. The ordinary CLI account retains the person's environment.

Gateway observations are redacted before entering the transcript or IPC, including a key split across message or reasoning deltas. A possible key prefix is retained only until it resolves or its stream ends; ordinary trailing text is preserved. If a tool approval contains the gateway credential, Modex denies that exact action without displaying it or approving a redacted substitute. Final errors and diagnostics remain redacted. These are synthetic-process guarantees; live provider acceptance and the destination decision remain separate.

If the one permitted retry also reports a usage limit, its account receives the reported cooldown too. No third attempt is made; the next new conversation can select another available account.
