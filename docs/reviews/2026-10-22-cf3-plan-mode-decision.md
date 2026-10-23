# CF-3: should Plan mode use Codex's native plan collaboration mode?

A decision for Val, from [#276](https://github.com/TypeSafeAI/modex/issues/276) (CF-3 of tracker
[#273](https://github.com/TypeSafeAI/modex/issues/273)). No code changes with this document.

**The question.** Modex's Plan mode is a prompt prefix on an ordinary Codex turn. Should it instead
start the turn in Codex's native **plan collaboration mode** (`turn/start` with
`collaborationMode: { mode: "plan", … }`)? With default codex-cli 0.163.0 settings, that mode is where
Codex offers its question tool (`item/tool/requestUserInput`). It is also where Codex returns its plan
as a `plan` item.

**Decision, 2026-10-22: yes.** Val approved the recommendation below. It is implemented as described
in "If Val says yes"; see [human-requests.md](../human-requests.md#plan-mode-on-codex) and the live
check at the end of this document.

**Recommendation: yes, as one change that also renders Codex's `plan` items.** Switching the mode
without rendering them would be a regression: the capture below shows the native turn's answer
arrives only as a `plan` item, which Modex does not read today. Claude's Plan mode is unchanged.

## What happens today

- `Plan` sets `opts.plan`. `CodexBackend` prepends `PLAN_PREFIX` ("PLAN MODE: Investigate the
  codebase read-only and reply with a concrete, numbered implementation plan…") and runs the turn
  read-only: `approvalPolicy: "untrusted"`, `sandbox: "read-only"` (`backends/codex.ts`).
- The plan reaches the transcript as the final `agentMessage`, like any answer. Codex's
  `turn/plan/updated` step list still becomes Modex's `plan` card (docs/task-context.md). That is a
  different thing from Codex's `plan` *item*, despite the shared name.
- Codex does not offer its question tool on an ordinary turn unless the under-development
  `default_mode_request_user_input` feature is on. The #348 through-app capture turned it on in a
  wrapper; without it, one run produced the separate `request_user_input_async` form, which the broker
  does not answer.

## Live capture, 2026-10-22

`apps/desktop/.probes/cf3-plan/capture.mjs` (ignored; a copy is kept with the evidence) drove
`codex app-server` directly. It ran the same task twice in a disposable git repo containing
`README.md` and `greet.js`. The task: "Add a greeting.txt file with a greeting for new users. Which
language the greeting should be in is not decided yet." Both runs were read-only with the policy Plan
mode uses today. Every command approval was declined, so nothing ran and no file changed. Questions were
parsed by Modex's own `codexQuestions` and answered by `codexAnswerResponse` with the first option.

- **Versions.** `codex-cli 0.163.0`. The thread model was `gpt-6-astra` (the account default).
  Claude Code `2.1.308` was installed but not exercised.
- **Collaboration modes.** `collaborationMode/list` offered two:
  - `Plan`: `mode: "plan"`, `reasoning_effort: "medium"`.
  - `Default`: `mode: "default"`.

| | Today: prefix on an ordinary turn | Native plan collaboration mode |
| --- | --- | --- |
| Time | 22.1 s, `completed` | 21.5 s, `completed` |
| Items completed | `userMessage`, `agentMessage`, `commandExecution` (declined), `reasoning`, `agentMessage` | `userMessage`, `agentMessage`, `commandExecution` (declined), `plan` |
| Structured question | none | one `item/tool/requestUserInput`, `isBlocking: true` |
| The undecided language | assumed English, with "Decide the greeting language before implementation" as step 1 | asked: Language, with English (Recommended), Spanish, French and free text |
| Where the plan is | the final `agentMessage`: a numbered list, with risks | a `plan` item (Markdown), plus 75 `item/plan/delta` notifications; no final `agentMessage` |
| Tokens (thread total) | 38,483 (251 output) | 61,226 (275 output) |
| Approval prompt for a read-only `rg` | yes (`untrusted`) | yes (`untrusted`) |

The native question, as Codex sent it:

```json
{ "itemId": "call_a01c07b0…", "isBlocking": true, "autoResolutionMs": null,
  "questions": [{ "id": "greeting_language", "header": "Language",
    "question": "Which language should the greeting in greeting.txt use?", "isOther": true, "isSecret": false,
    "options": [{ "label": "English (Recommended)", "description": "Use “Welcome! We're glad you're here.”" },
                { "label": "Spanish", "description": "Use “¡Bienvenido! Nos alegra que estés aquí.”" },
                { "label": "French", "description": "Use “Bienvenue ! Nous sommes heureux de vous accueillir.”" }] }] }
```

The answer `{ "answers": { "greeting_language": { "answers": ["English (Recommended)"] } } }` was
accepted. The turn then completed with this `plan` item and no further agent message:

````text
### Add a new-user greeting

Create `greeting.txt` in the workspace root with the selected English greeting:

```text
Welcome! We're glad you're here.
```

- End the file with a newline.
- Verify the filename and exact content; no automated tests are needed.
- Workspace inspection was denied, so check applicable `AGENTS.md` instructions before implementation.
````

`turn/completed` carried `items: []` with `itemsView: "notLoaded"`, so the plan is only in
`item/completed` (and the deltas).

## Trade-offs

**For switching:**

- **Codex asks instead of assuming.** In the capture it asked the one open question, with
  recommended options, and planned on the answer. Today it picked English and buried the decision in
  step 1. Plan mode is the moment a clarifying question is cheapest.
- **The question card is ready.** The broker, desktop card, phone card (CF-3 slice 1),
  refusals, Stop and secret handling already exist. The capture's request matched `codexQuestions`
  exactly, as #357's did.
- **No reliance on an under-development flag.** The question tool comes with the mode, so ordinary
  users get it without `default_mode_request_user_input`, and without its `request_user_input_async`
  variant that Modex cannot answer.
- **Codex's own planning instructions.** `developer_instructions: null` selects the built-in plan
  instructions, so `PLAN_PREFIX` would be dropped rather than maintained alongside them.

**Against, or costs:**

- **The plan moves to a `plan` item.** Modex must render it (a Markdown block, streamed from
  `item/plan/delta`, final text from `item/completed`, which the schema calls authoritative). It must
  also export, journal and replay it, and show it to older clients. That means a new item kind or an
  assistant item with a plan phase, a phone fallback, and `x-modex-item-kinds` handling for Store
  0.0.8. Until then, a native Plan turn shows only "I'll check the workspace…". This is the main cost.
- **Experimental protocol.** `collaborationMode`, the `plan` item and `item/plan/delta` are all
  marked EXPERIMENTAL in `generate-json-schema --experimental`; the stable schema has none of them.
  Modex already opts into `experimentalApi`. A codex-cli update could rename them. Keep a fixture
  from this capture and treat a refused `collaborationMode` as "fall back to the prefix" with a notice.
- **The preset overrides Modex's picker.** The mode "takes precedence over model, reasoning_effort,
  and developer instructions". `settings.model` is required, and the Plan preset carries
  `reasoning_effort: "medium"`. Modex would have to pass the thread's model and chosen effort in
  `settings` explicitly, or the model and effort pickers stop meaning anything in Plan mode.
- **Cost and latency.** A question adds a round trip: 61k vs 38k total tokens here (mostly cached
  input), similar wall time. A blocking question also leaves an unattended Plan turn waiting. Routines
  already decline questions, which is the right default.
- **Behaviour change for existing users.** Plan answers would look different (Markdown plan, not a
  numbered message) and may ask before answering. That needs a status entry, and a release note.
- **Codex only.** Claude Code sends Modex no structured questions (docs/human-requests.md), so Plan
  mode would ask on Codex and not on Claude. That is the case today for every other question as well.

**Not affected:** the read-only sandbox and `untrusted` approvals stay Modex's choice; the capture's
native run still asked before `rg`. Stop, withdrawal and secrets go through the existing broker.

## Options

1. **Switch, with `plan` items rendered (recommended).** One PR:
   - Plan turns on Codex use `collaborationMode: { mode: "plan", settings: { model, reasoning_effort, developer_instructions: null } }`.
   - `item/plan/delta` and `plan` items render.
   - The prefix stays as a fallback when the server refuses the mode.
   - Tests replay this capture.
2. **Turn on `default_mode_request_user_input` for every Codex turn.** Questions everywhere, no plan
   items. Rejected for now: the CLI lists it as under development and off by default, and without it
   Codex can choose the async form instead.
3. **Keep the prefix.** No questions in Plan mode by default; a person can still enable the feature
   in their own Codex config. Zero risk, and the question card stays mostly unseen.

## If Val says yes

- Map `plan` items (`{ id, text }`) to a transcript item with `phase: "plan"`, streamed from deltas.
  Add the phone and older-desktop fallbacks, and journal replay. Red tests from this capture first.
- Pass the thread's model and effort in `settings`. Test that the pickers still apply.
- Keep `PLAN_PREFIX` only for the fallback path, and say so in a notice when used.
- Live-verify one Plan turn through the app, with the question answered on the desktop and on the phone.
- Update `docs/task-context.md`, `docs/human-requests.md` and `docs/status.md` (Known rough edges).

## After the decision: live check through Modex

Val approved the decision on 2026-10-22. The implementation passes Modex's model and effort in
`settings`, renders the `plan` item as the turn's final assistant answer (`nativePhase: "plan"`), and
keeps the prefix as a fallback. Instead of `PLAN_PREFIX`, it sends `developer_instructions: null`.

`apps/desktop/.probes/native-plan/live.mjs` (a copy is kept with the evidence) ran one Plan turn
through Modex's real `CodexBackend`, `ThreadRunner` and broker against codex-cli 0.163.0, read-only,
with every command declined. Captured at `2026-10-22T20:54:52Z`; `native-plan-live.json`, SHA-256
`11ef2116c3a079465be7cb2545daac29c8d0dc987ba3341f9bdef4a69d8d6d82`. The transcript Modex recorded:

1. A commentary message: "I'll check the repository for any greeting conventions, then ask you to choose a language."
2. A declined command.
3. A question card (Language: English (Recommended), Spanish, French, and Other), answered through
   `answerQuestion` with `delivery: "sent"`.
4. The final assistant answer, `nativePhase: "plan"`: "## Add a new-user greeting…".

The turn completed in 13 s. No Plan-mode feature flag was set.

## Evidence

- **The full protocol log of both runs.** `plan-capture.json`, SHA-256
  `d4d2720779e59d29c0b8ea860c87b4736e98c23bbf25660c840bb9af59c3b333`, captured at
  `2026-10-22T19:24:01Z`.
- **The probe.** `plan-capture-probe.mjs`.

Both are kept outside the tree in `~/.claude/task-evidence/cf3-2026-10-22/` on Val's Mac. Main was
`0e674e7` when they were captured.
