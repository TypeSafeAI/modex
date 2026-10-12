# Sticky Auto routing

Approved on 2026-10-12; not implemented. This specification changes when Auto may change a
thread's model, reasoning effort and fast mode between turns, and adds the usage measurement
that decision needs. It does not change the judge, its questions, or which backends Auto may
use.

## Problem

Auto ([auto-routing.md](../auto-routing.md)) decides every turn from scratch. `decide()` in
`apps/desktop/src/main/engine/routing/policy.ts` picks a tier from the request alone and takes
the best model at that tier. The runner writes it to the thread, and the next CLI call resumes
the session with the new `--model` (Claude) or `model` on `turn/start` (Codex). Backend
switches are already guarded because they lose the CLI session. Model switches inside one
backend are not, although they lose the prompt cache.

On a long thread the history dominates a turn's input, and the cache is what makes it cheap:

- Anthropic's prompt cache is scoped to one model. A switch re-reads the whole history
  uncached and writes a new cache entry, at 2× base input price with the 1-hour lifetime
  Claude Code uses.
- A top-level change to reasoning effort or to fast mode also invalidates the cached history.
- Thinking blocks are bound to the model that produced them. Another model drops them
  silently, so after a switch the new model sees what was done but not why.

The next turn on a 150k-token thread that last ran on Opus 5.5, at list prices of 2026-10-06:

| Next turn on | Input cost of the history | vs. staying |
| --- | --- | --- |
| Opus 5.5, cache warm | $0.03 | 1× |
| Haiku 5.5, cold | $0.15 | 5× |
| Sonnet 5.5, cold | $0.60 | 20× |
| Fable 5.1, cold | $3.00 | 100× |

A downgrade to Sonnet 5.5 pays back only above about 57k output tokens on that turn, because
cached reads cost the same on both models ($0.20/MTok). A Haiku 5.5 detour breaks even near
7k output tokens, and only if Opus's cache is still warm when the thread returns. Once a
thread has been idle past the cache lifetime, every model starts cold and the cheaper model
wins. Users on a Claude or ChatGPT plan pay in latency and usage limits instead of dollars.

Modex cannot see any of this today. `resultOf()` in `backends/claude.ts` discards Claude's
usage, and the Codex backend ignores token-usage notifications. Jev answers
`depends_on_prior_turns` on every turn, and the policy never reads it.

## Decisions

- Auto stays free to choose on a thread's first turn, on a small thread, and whenever the
  thread's cache is likely cold. Otherwise it keeps the model.
- While the cache is warm, Auto never moves down a tier and moves up only on a big jump.
- Measurement ships first, as its own PR, with no change to routing.

## Part 1: measure (PR 1)

### Turn usage

`apps/desktop/src/main/engine/backends/types.ts` gains:

```ts
/** Token usage a backend observed during one turn, for Auto routing and its records. */
export interface TurnUsage {
  /** The turn's first model call on the thread's own session: did it find the cache warm? */
  first: { cacheRead: number; cacheWrite: number; uncached: number };
  /** Total input of the turn's last model call (read + written + uncached): what the next turn re-reads. */
  contextTokens: number;
  /** Output tokens for the turn, reasoning included, as the CLI reports them. Informational only. */
  outputTokens?: number;
  /** Model calls counted. */
  calls: number;
}
```

`TurnResult` gains `usage?: TurnUsage`, left unset when the backend observed no model call.
Parser fixtures are copied from real CLI output captured on this machine, not written by hand.

**Claude.** Each `assistant` stream message carries `message.id` and `message.usage`
(`input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`).
One API call can produce several assistant messages with the same id and identical usage, so
each id counts once. Messages with a non-null `parent_tool_use_id` belong to sub-agents, which
have their own context, and are ignored. A call's input is the sum of the three input fields.
Calls made by the follow-up turns that the CLI starts after background work count, since they
run on the same session. `outputTokens` is the `result` message's `usage.output_tokens` when
present.

**Codex.** `thread/tokenUsage/updated` notifications whose `threadId` is the turn's thread
(checked against `codex app-server generate-json-schema` on codex-cli 0.162.1). Each carries
`tokenUsage.last`, the latest response's `inputTokens`, `cachedInputTokens`,
`cacheWriteInputTokens` and `outputTokens`. The turn's first notification fills `first`; its
last fills `contextTokens`. Whether `inputTokens` already includes the cached and written
tokens is read from a captured notification before the parser is written, and the parser
follows what it shows. `outputTokens` is the sum of `last.outputTokens` over the turn's
notifications if the captured payloads show one notification per response; otherwise Codex
leaves it unset.

### What the cache was built with

`Thread` in `apps/desktop/src/shared/types.ts` gains:

```ts
/** The last turn that reached a model: what the backend's prompt cache was built with. */
lastTurn?: { at: string; model: string; effort?: string; fast: boolean; contextTokens?: number };
```

- The runner writes it when a turn ends, whatever its status, if `usage.calls > 0`. It also
  writes it when a turn completes without usage, so a CLI that reports none still leaves a
  record, with `contextTokens` unset.
- `at` is when the turn ended. It slightly overstates how recent the last call was, which
  errs toward keeping the model.
- `model`, `effort` and `fast` are what the turn ran with.
- It is cleared wherever `sessionHandle` is cleared (a backend change in `updateThread`), and
  when the session sink replaces an existing handle with a different one.
- Every thread gets it, Auto or not, so turning Auto on mid-thread finds a record. State
  written before this change loads unchanged.

### Routing records

`RouteRecord` in `routing/fit.ts` gains `idleMs` and `contextTokens` from `lastTurn` at
decision time. `noteOutcome` receives the turn's `TurnUsage` and adds `cacheRead`,
`cacheWrite` and `uncached` from the first call, plus `turnContextTokens` and `outputTokens`.
All are optional. These records are the evidence for Part 2's constants: first-call cache
reads against idle time give each backend's real cache lifetime, and the records before and
after a switch show its real cost.

### Probe

After PR 1 merges, run one manual probe per CLI on a development build, in a thread grown past
50k tokens. It spends real tokens on the signed-in accounts and is not part of CI.

1. Two turns with the same model and effort. Expect the second turn's first-call `cacheRead`
   to be close to the first turn's `contextTokens`.
2. Change only effort.
3. Change only fast mode, on a model that offers it.
4. Change only the model.

Record the first-call `cacheRead` and `cacheWrite` of each step. Steps 2 and 3 set
`EFFORT_CLEARS_CACHE` and `FAST_CLEARS_CACHE` per backend. The results go in PR 2's
description and in `docs/auto-routing.md`. Codex's cache lifetime is read from routing records
over the following days. Until then Codex uses the same assumed lifetime as Claude.

## Part 2: hold the model (PR 2)

### Inputs

`DecisionInput` gains `lastTurn?: Thread["lastTurn"]` and `idleMs?: number`. The router
computes `idleMs` as `max(0, now − Date.parse(lastTurn.at))`, so `decide()` stays pure.

### Warmth

The first class that matches applies:

1. `none`: the thread has no session yet, or the backend is mock.
2. `unknown`: the thread has a session but no `lastTurn`, because it predates PR 1.
3. `cold`: `lastTurn.model` differs from the thread's model (the user picked another model
   since, so the cache is not for it), or `idleMs >= CACHE_LIFETIME_MS[backend]`.
4. `small`: `lastTurn.contextTokens < SMALL_CONTEXT_TOKENS`.
5. `warm`: anything else, including a record whose size is unknown.

The hold applies only to `warm` and `unknown`.

### The hold step

It runs after step 6 of `decide()` has produced the free decision. It does not run when the
current model is no longer allowed: it is missing from the ladder, or the premium budget is
spent and it is tier 3. Limits win over the cache. The confidence gate (step 1) and blocked
routes return before it, unchanged. Backend switching never meets it, because a switch already
requires a thread without a session.

With `c` the current model's tier and `f` the free decision's tier:

- `f < c`, or `f = c` with a different model: hold.
- `f > c`: take the free decision only if `f − c >= UPGRADE_TIERS`, or if
  `needsDeepReasoning >= DEEP_REASONING_UPGRADE` and
  `dependsOnPriorTurns < PRIOR_TURNS_DEPENDENT`. Otherwise hold. A request that builds on
  earlier turns loses the most from dropped thinking blocks, so it needs the full jump.
- `f = c` with the same model: keep the model. Effort is held if
  `EFFORT_CLEARS_CACHE[backend]`, otherwise it is the free decision's. Fast mode is held if
  `FAST_CLEARS_CACHE[backend]`, otherwise it is the free decision's.

A hold keeps the current model and backend and takes effort as `keepCurrent()` already does:
the current effort when the model supports it and it is within the ceiling. Fast mode is
`lastTurn.fast` when `policy.allow_fast` is on and the model still offers it, otherwise off.
A held effort above a lowered ceiling is still clamped. The decision has `held: true` and
`pinned: false`.

### Constants

In `routing/policy.ts`, not in Settings:

```ts
/** How long a backend's prompt cache is assumed to survive an idle thread. Corrected from routing records. */
export const CACHE_LIFETIME_MS: Record<BackendId, number> = { claude: 60 * 60_000, codex: 60 * 60_000, mock: 0 };
/** Below this many context tokens a switch re-reads too little to matter. */
export const SMALL_CONTEXT_TOKENS = 20_000;
/** A warm thread moves up only to a model at least this many tiers higher... */
export const UPGRADE_TIERS = 2;
/** ...or when Jev is this confident the request needs deep reasoning... */
export const DEEP_REASONING_UPGRADE = 0.85;
/** ...and the request does not lean on earlier turns this strongly. */
export const PRIOR_TURNS_DEPENDENT = 0.7;
/** Whether changing effort or fast mode alone clears the backend's cached history. Set from the probe. */
export const EFFORT_CLEARS_CACHE: Record<BackendId, boolean> = { claude: true, codex: true, mock: false };
export const FAST_CLEARS_CACHE: Record<BackendId, boolean> = { claude: true, codex: true, mock: false };
```

### Receipts and records

- `Decision`, the route `ThreadItem` and `RouteRecord` gain `held?: true`. `RouteRecord` also
  gains `warmth`.
- `RouteItem` in `renderer/components/ThreadView.tsx` labels a held route "Auto kept", as it
  does a pinned one.
- Reasons say what happened, with tokens rounded to thousands and idle time in minutes:
  - Held: "Kept Opus: ~150k tokens cached, last turn 4 min ago. Switching would re-read them
    uncached."
  - Cold: "Idle 72 min, cache likely expired, so free choice."
  - Upgrade: "Moved up to Fable despite the warm cache: two tiers above Opus."
  - Unknown: "Kept Opus: no cache record for this thread yet."
- Premium accounting is unchanged: a held tier-3, `xhigh` or `max` turn counts as premium.
- Learning is unchanged. A hold teaches nothing, and a model picked by hand still calls
  `noteOverride`.

## Edge cases

- **No usage, and the turn did not complete:** `lastTurn` stays as it was. Inside the cache
  lifetime, the next turn is warm with an unknown size and held.
- **A failed or interrupted turn that made calls** still writes `lastTurn`, because it warmed
  the cache.
- **Blocked routes** never write `lastTurn`; no turn ran.
- **A clock change** that makes `idleMs` negative counts as 0.
- **A thread from before PR 1** is held for one turn, after which it has a record.
- **A thread whose `lastTurn.effort` is unset**, because it ran before Auto was on, takes the
  effort `keepCurrent()` chooses. That can change effort once.

## Testing

- **Policy table tests** (`routing/policy.test.ts`) cover:
  - each warmth class;
  - downgrade held, same-tier swap held, one-tier upgrade held;
  - two-tier upgrade taken;
  - deep-reasoning upgrade taken, and held when the request depends on prior turns;
  - effort and fast held, and taken freely when the matching `*_CLEARS_CACHE` is false;
  - a premium-exhausted tier-3 current model not held;
  - mock never held.
- **Backend parsers** are tested from captured fixtures: duplicate Claude message ids,
  sub-agent messages, follow-up turns after background work, Codex notifications for another
  thread, and turns with no usage.
- **Runner tests** check that `lastTurn` is written, kept, and cleared as specified, and that
  `noteOutcome` receives the usage.
- **End-to-end tests** do not change, because mock is never held.

## Documentation

- `docs/auto-routing.md`:
  - PR 1 adds what is measured and where it is recorded.
  - PR 2 adds a "Holding the model" step after fast mode, with the probe results and
    constants, and widens step 3's note on mid-thread switches to cover model, effort and
    fast-mode switches.
- `docs/status.md` records each PR as in flight and then shipped.

## Acceptance criteria

PR 1:

- Claude and Codex turns report `TurnUsage`, parsed from captured fixtures, with duplicate and
  sub-agent messages excluded.
- `lastTurn` is written and cleared as specified, and older state loads.
- Routing records carry idle time, context size and first-call cache figures.
- Routing behaves exactly as before: the existing policy and router tests pass unchanged.
- `npm run build && npm test` and `npm run test:e2e` pass.

PR 2:

- Every warmth class and hold rule has a policy test.
- A held route reads "Auto kept" with its cache reason.
- `EFFORT_CLEARS_CACHE`, `FAST_CLEARS_CACHE` and the documentation reflect the probe results.
- `npm run build && npm test` and `npm run test:e2e` pass.

## Out of scope

- Sending cheap side tasks to a separate short-lived session instead of switching the
  thread's model.
- Choosing models from a price table.
- Per-message effort or any other API-level cache control. Modex drives the CLIs only.
- Settings for the new thresholds.
- Checking that a freely chosen model's context window fits the thread. Free choice already
  ignores this today, and this specification does not change it.
