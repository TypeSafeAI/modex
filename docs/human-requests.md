# Human requests

How a CLI's approvals and questions reach a person and how one local answer is accepted and its delivery is recorded. This
is the contract from [#276](https://github.com/TypeSafeAI/modex/issues/276) (CF-3 of tracker
[#273](https://github.com/TypeSafeAI/modex/issues/273)). It builds on the conversation identity in
[conversation-events.md](conversation-events.md) and on CF-2's withdrawn cards
([#275](https://github.com/TypeSafeAI/modex/issues/275)).

The pure contract is `apps/desktop/src/shared/human-requests.ts`. The runner
(`src/main/engine/runner.ts`) owns the authoritative state. The backends map native requests onto it.
Nothing here executes anything or talks to a provider. Coding turns still run only through
`codex app-server` and `claude -p`.

## What changed

Before, an approval card resolved a promise the first time anyone answered it, and every other answer
was silently ignored. A client could not tell "accepted" from "too late". Cards left open by a process
that died stayed actionable after a restart, though nothing was listening. Codex's
`item/tool/requestUserInput` questions were declined with `-32601`.

Now:

- Every request is registered with a binding (who asked) and a digest (what exactly it asks).
- Exactly one answer is accepted. Every other answer gets an explicit refusal.
- Codex questions are cards with a control for each question. Answers are checked against the questions
  before anything reaches the CLI.
- A secret answer reaches the CLI and nowhere else.
- Cards nobody can answer any more are closed everywhere, including after a restart.
- The iPhone app answers questions on a native card, through the same broker as the desktop.

## Contract

```ts
interface RequestBinding {
  thread: string; turn: string; attempt: string;   // the Modex turn and attempt (TurnRef)
  backend: BackendId; account?: string;            // opaque account binding, never a credential
  runtime: string;                                 // the CLI process generation whose ids these are
  nativeRequestId: string;                         // Codex JSON-RPC id; Claude control request_id
  item?: string;                                   // the native item it is about (Codex itemId, Claude tool_use_id)
}

interface Question {
  id: string; header: string; text: string;
  options: { label: string; description: string }[] | null;  // null: free text
  allowOther: boolean;                                         // free text besides the options
  secret: boolean;                                             // sent to the CLI; never shown, saved or exported
}

type HumanRequest =
  | { kind: "approval"; id; binding; action: unknown; digest: string; canAlways: boolean }
  | { kind: "question"; id; binding; questions: Question[]; blocking: boolean; digest: string };

type Resolution =
  | { kind: "approval"; answer: "yes" | "no" | "always" }
  | { kind: "question"; answers: Record<string, string[]> };

type RequestState = "pending" | "resolving" | "resolved" | "withdrawn" | "uncertain";
type Refusal = "unknown" | "already-resolved" | "withdrawn" | "wrong-identity" | "changed-action" | "invalid";
```

The broker functions are pure. Each one takes `RequestsState` and returns a new one:

| Function | What it does |
| --- | --- |
| `register(state, request)` | Adds a `pending` request. Registering an id twice changes nothing. |
| `resolve(state, id, resolution, { binding, digest, by })` | Accepts one answer for a `pending` request and moves it to `resolving`. Otherwise it refuses with a reason. |
| `settle(state, id, "sent" \| "uncertain")` | Records the send. Only a `resolving` request changes. |
| `withdraw(state, { id } \| { thread, turn?, attempt? })` | Moves `pending` requests to `withdrawn`, and `resolving` ones to `uncertain`. |
| `actionDigest(action)` | Gives a stable digest of the exact action. A changed action is a new request. |
| `validateAnswers(questions, answers)` | Requires every question answered, choices from the options unless other text is allowed, and no unknown ids. |
| `publicAnswers(questions, answers)` | Returns the answers as they may be shown, saved or exported. A secret answer becomes `"(hidden)"`. |
| `codexQuestions(params)` | Maps Codex `requestUserInput` params to questions, or to `null` when they are malformed. |
| `codexAnswerResponse(answers)` | Builds Codex's `{ answers: { [id]: { answers } } }`. |

Refusals, in the order `resolve` checks them:

| Reason | When |
| --- | --- |
| `unknown` | There is no request or card with this id. |
| `withdrawn` | The request went away before any answer: Stop, the turn ended, or the CLI withdrew it. |
| `already-resolved` | Another answer was accepted first. |
| `wrong-identity` | The claim names a different thread, turn, attempt, backend, account, runtime or native request. |
| `changed-action` | The digest differs from the request's. |
| `invalid` | The answer is the wrong kind, or the answers fail `validateAnswers`. |

`answer` and `answerQuestion` return `{ ok: true }` for local acceptance, once the card is saved. If
that save fails, they throw and accept nothing (see "A failed save" below). The request stays
`resolving` until the backend's stdin write callback succeeds. The card then records
`delivery: "sent"`. This receipt proves a local transport handoff, not remote execution.

If Stop, native withdrawal, an obsolete identity, changed approval rules, a write error, or a closed
input wins before that receipt, the card records `delivery: "uncertain"`. It stays inert and is never
resent automatically. After restart, saved `sending` cards become `uncertain`; saved `sent` and
`uncertain` receipts remain unchanged. Check the agent before starting a new request.

## Runner

`ThreadRunner` keeps the running turn's requests in `Live.requests` and the waiting promises in
`Live.pending`. The pending map is typed: an approval settles with an answer, and a question settles
with answers or a withdrawal. Requests live only while their turn runs. They are reset when the next turn
starts and when one ends, so a secret answer is gone from memory with its turn. Afterwards, the card's own
fields say how it closed.

```ts
answer(threadId, itemId, answer: ApprovalAnswer, by = "desktop"): AnswerResult
answerQuestion(threadId, itemId, answers: Record<string, unknown>, by = "desktop"): AnswerResult
type AnswerResult = { ok: true } | { ok: false; reason: Refusal; error?: string };
```

- **Binding.** The sink builds each request's binding from the attempt's `TurnRef` and the backend's
  `NativeRequest` (`{ runtime, request, item? }`). Clients name a card by its item id. Modex mints
  that id for each request, so it stands for the binding. The runner supplies the binding and the
  digest when it resolves. Main snapshots the request and accepted answer, revalidates the current
  backend, account, attempt, native identity, action, and approval-rule configuration at acceptance
  and immediately before the write. A changed action, mode, or rule configuration invalidates its
  card. Automatic decisions also revalidate the standing approval mode; changing a manual card
  from Ask to YOLO retains its existing behavior.
  Request IDs remain scoped to the runtime; Codex numeric and string IDs stay distinct.
- **Questions.** `TurnSink.question(req, withdrawn?)` adds a `question` card. A blocking question
  sets the thread to `waiting`; a non-blocking one lets the turn run on. `answerQuestion` validates
  the answers and gives `error` text for an invalid one (for example "Token needs an answer.").
  Only then does anything reach the CLI. The card saves `publicAnswers`.
- **Withdrawal.** `withdraw(threadId, l, itemId, "native" | "stopped" | "ended")` closes a card
  once. An approval closes as `answer: "no"` plus `withdrawn`, so older clients show it closed. A
  question closes with `withdrawn` alone, and its sink settles with `{ withdrawn }`, never with empty
  answers. A decision already accepted remains an inert `uncertain` receipt if withdrawal wins.
- **Restart.** When a thread first loads in a new process, any approval without an answer and any question
  without answers or a withdrawal is closed as `withdrawn: "ended"`. The change is saved, and emitted as
  `item_update`, so the journal and paired clients see it too. Interrupted `sending` receipts become
  `uncertain` and never revive a send.
- **Routines.** An unattended routine has nobody to ask. Approvals are refused with a receipt, as
  before. Questions are declined with a warning notice.

Each native request is handled once per turn. An identical replay retains the original card and
cancellation controller. Reusing an ID for a changed action withdraws the original request and requires
a new ID. Delivery is claimed synchronously before awaiting its write callback, so concurrent handlers
cannot write two answers for one native ID. This is a local guard, not an exactly-once remote guarantee.

## Native mappings

### Codex (codex-cli 0.163.0, `app-server`)

| Native | Modex |
| --- | --- |
| `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval` | Approval cards, as before, now carrying `native: { runtime: generation, request: id, item: itemId }`. |
| `item/tool/requestUserInput` (experimental) | A question card through `codexQuestions`. A malformed request is declined whole with `-32602`, and a warning notice. |
| Answers | Sent as `{ answers: { [questionId]: { answers: string[] } } }`. |
| `serverRequest/resolved` for a request still open | Codex settled the request itself. The card closes as `withdrawn: "native"`, and Modex sends no answer. |
| Stop, or the turn ending, while a question waits | The CLI gets error `-32000` ("withdrawn by modex: …"), never an empty answer. |
| A sink with no `question` method | Declined with `-32601`, as before. |

**Live evidence, 2026-10-20.** One codex-cli 0.163.0 turn (model `gpt-6.1-sol`, read-only), with
Val's approval, was asked to put one clarifying question through Codex's question tool. It is
recorded in `apps/desktop/test/fixtures/codex-request-user-input-0.163.0.json`.
- **The request.** Codex sent `item/tool/requestUserInput` with `threadId`, `turnId`, `itemId`,
  `questions: [{ id, header, question, isOther, isSecret, options: [{ label, description }] }]`,
  `isBlocking: true` and `autoResolutionMs: null`. The schema marks `autoResolutionMs` deprecated in
  favour of `isBlocking`, which `codexQuestions` honours.
- **Modex's handling.** `codexQuestions` read the live request as the fixtures predicted. Codex
  accepted `codexAnswerResponse`'s answer and completed the turn. A unit test replays the sample.
- **Where it was asked.** This direct app-server probe used Codex's **plan collaboration mode**:
  `turn/start` with `collaborationMode: { mode: "plan", … }`. With default 0.163.0 settings,
  `default_mode_request_user_input` is off. The probe verifies the parser/answer protocol, not
  the app's broker, card, transport, or human acceptance.
- **Through the app.** Modex's Plan mode is a prompt prefix on an ordinary turn. A separate
  [through-app capture in #348](https://github.com/TypeSafeAI/modex/blob/1847e0c8808b96b636693b786e152a9f76471be3/docs/reviews/2026-10-20-cf3-drafts.md#native-evidence-and-remaining-gates) enabled the opt-in
  `default_mode_request_user_input` flag: the card sent Blue and the model replied Blue.
  Without that flag, another run used the distinct `request_user_input_async` form, which this
  broker does not answer. Human keyboard/VoiceOver acceptance remains open.
- **Native Plan integration.** In plan collaboration mode, Codex completes with a `plan` item
  (`{ id, text }`, streamed by `item/plan/delta`) and no final agent message. Val chose native plan
  mode for Plan turns on 2026-10-22 ([decision](reviews/2026-10-22-cf3-plan-mode-decision.md)); see
  "Plan mode on Codex" below.

### Plan mode on Codex

A Plan turn on Codex starts in Codex's plan collaboration mode:
`turn/start` with `collaborationMode: { mode: "plan", settings: { model, reasoning_effort, developer_instructions: null } }`.

- **Model and effort.** The mode overrides the turn's model and effort, so `settings` carries the
  model picked in Modex. When Modex picked none, it carries the model Codex reported for the thread
  in its `thread/start` or `thread/resume` reply. `settings` also carries the picked effort, or null
  for Codex's own plan default.
- **Instructions.** `developer_instructions: null` selects Codex's own plan instructions, so the
  `PLAN MODE:` prompt prefix is not sent.
- **Unchanged.** The sandbox stays read-only with `untrusted` approvals. Questions arrive as
  `item/tool/requestUserInput` and use the question card, with no feature flag.
- **The plan.** Codex's `plan` item becomes an assistant item with `phase: "final"` and
  `nativePhase: "plan"`: the turn's answer, streamed from `item/plan/delta`. The text comes from
  `item/completed`, which the schema calls authoritative. Every client already shows assistant
  items, so older desktops, Store builds and phones see the plan as Markdown text.
- **Fallback.** If Codex refuses the field (an RPC error naming the collaboration mode), or no model
  is known, the turn runs with the prompt prefix as before, and an info notice says so.
- **Routines.** A Plan routine also runs in native plan mode. It declines any question with a
  warning, as routines always have.

Both `collaborationMode` and the `plan` item are experimental in codex-cli 0.163.0.
`test/codex-native-plan.test.ts` replays the live capture's shapes, and
`e2e/codex-native-plan.spec.ts` runs a Plan turn through the real UI.

**Live check, 2026-10-22, codex-cli 0.163.0.** One Plan turn ran through Modex's own `CodexBackend`,
`ThreadRunner` and broker, read-only, with every command declined.
- Codex asked one question (Language, three options).
- `answerQuestion` took the first option and recorded `delivery: "sent"`.
- The turn ended with the plan as the final assistant item (`nativePhase: "plan"`), in 13 s.

### Claude Code (2.1.302, `claude -p` stream-json)

| Native | Modex |
| --- | --- |
| `control_request` `can_use_tool` | An approval card with `native: { runtime, request: request_id, item: tool_use_id }`. |
| `control_cancel_request` | The card closes as `withdrawn: "native"` (CF-2), and no answer is sent. |
| Other control request subtypes | Answered with an error, as before. Claude sends Modex no structured questions. |

## Clients

- **Desktop.** `thread:answer` now returns `AnswerResult`. `thread:answer-question
  { threadId, itemId, answers }` answers a question card. The card (`transcript/QuestionCard.tsx`)
  gives each question its own control:
  - options are radio buttons, with Other when the question takes free text;
  - a free-text question gets a text field;
  - a secret question gets a password field.

  Unsent question choices and text survive switching threads or opening a new chat. They live
  only in window memory, keyed by thread and request item, and are discarded when the request
  closes (including a background answer or withdrawal), the thread is removed/retired, or the
  window closes. Secret drafts never enter composer recovery or persistent storage.

  Sending and uncertain cards show their delivery state and have no submit control. An uncertain
  card does not read as answered. Secret input is sent with its original whitespace; validation only
  checks that it is not empty.

  A refusal is shown on the card. An answered card lists the answers, with a secret one shown as
  "(hidden)". A closed card says why, in the approval card's words. While a question waits, the turn
  header reads "Waiting for your answer" instead of "Waiting for approval". An answered or closed card
  folds into the turn's work like an answered approval; an open one never does.
- **Phone.** The phone answers approvals and, from this change, questions. Both go through the runner's
  broker with `by: "phone"`, so the phone gets the same refusals as the desktop.
  - **Which phones get a card.** The iPhone app names the item kinds it draws in the
    `x-modex-item-kinds` header that paired desktops already send (`user,assistant,approval,tool,notice,question`).
    A phone that names `question` gets the card from `phoneItem`: its questions (id, header, text,
    options, allowOther, secret), `blocking`, and once it closes, `answers`, `answeredBy`, `delivery`
    or `withdrawn`. Answers are passed through `publicAnswers` again, so a secret is `"(hidden)"`
    whatever the card holds. A phone that names nothing, such as Companion 0.3.0 (8) and earlier, keeps
    the `info` notice with the question text and its state ("Answer it in Modex on your Mac.",
    "Answered on your Mac.", "Answered on your phone.", "Not answered."), never the answers. It cannot answer a question it
    cannot draw.
  - **Answering.** `POST /v1/threads/:id/answer-question { itemId, answers: { [questionId]: string[] } }`
    calls the runner's `answerQuestion`. A malformed body is a 400 that reaches nothing. `invalid` is a
    400 carrying the runner's text ("Token needs an answer."). Every other refusal is a 409 carrying
    `reason` (`already-resolved`, `withdrawn`, `unknown`, `wrong-identity`, `changed-action`) and a
    sentence for the person. A failed save is a 500, as for approvals. A Mac without a question
    broker answers 501. `/answer` still never answers a question.
  - **The card** (`QuestionCard` in `CompanionViews.swift`) has a control for each question: options
    as single-choice rows (with Other when free text is allowed), a text field, or a secure field for
    a secret. Nothing is sent until every question has an answer, and what is missing is said on the
    card. A secret is sent exactly as typed; other text is trimmed. A closed card says how it closed
    in the desktop card's words ("Answered on your phone", "Answered on your Mac", "Not answered — the
    turn was stopped", "Delivery uncertain…") and shows a secret as "(hidden)".
  - **Unsent answers** live only in the app's memory, by thread and card. They survive switching
    threads. They are dropped when the card closes (wherever it was answered), when its thread goes
    away, or when the Mac is forgotten, re-paired to another Mac, or swapped for the demo. They are
    never written to the Keychain, `UserDefaults` or a log.
  - Sending and uncertain receipts are explicit for approvals too, so older clients cannot mistake
    them for successful approvals.
- **Store demo.** `thread:answer` returns `{ ok: true }`. The demo asks no questions, so
  `thread:answer-question` refuses with `unknown`.
- **Older paired desktops.** A paired desktop names the item kinds it draws in an
  `x-modex-item-kinds` header on every request. Store builds cut before CF-3, such as TestFlight Store
  0.0.8, send none and have no `question` or `plan` in their renderer, so they showed nothing for one
  and the thread looked stuck. The host sends such a client a question, or a plan, as an `info` notice
  with the same id, the question text and its state, never the answers: in `thread:items`, in live and
  journaled events, and in journal replay. An update to one arrives as the whole notice again. Its
  answer is refused, as before. `test/desktop-item-kinds.test.ts` covers each path.

## Across replay and reconnect

The card is the record. A request's lifecycle travels in the card's own fields, in the `item` and
`item_update` events every client already reads, so the [event journal](event-journal.md), snapshots,
paired desktops and the phone carry it with no new event type. This is the request half of CF-6
([#279](https://github.com/TypeSafeAI/modex/issues/279)).

| Broker step | On the card |
| --- | --- |
| `register` | The card appears, with no answer. |
| `resolve` | `answer` or `answers`, `answeredBy` (`"desktop"`, `"paired-desktop"` or `"phone"`) and `delivery: "sending"`, saved before the CLI hears anything. |
| `settle(…, "sent")` | `delivery: "sent"` once the answer is handed to the CLI. |
| `withdraw` | `withdrawn: "native" \| "stopped" \| "ended"`, as above. |
| `uncertain` | `delivery: "uncertain"`. |

- **A restart** turns a card still `sending` into `uncertain`: Modex stopped between taking the answer
  and recording the hand-off, so nobody can tell whether the CLI got it. The answer is never sent again,
  and the card says so: "Modex stopped before it could confirm the agent received this answer." Cards
  nobody answered close as `ended`, as before. A card answered before these fields existed keeps no
  `delivery` and is left as it was.
- **A failed save** takes no answer. When saving the card fails, for example on a full disk, the request
  is open again, the card reads as it did, no client hears of the answer, and the CLI hears nothing.
  The client that answered gets the error (the phone a 500) and can answer again. If the failed write
  did reach the disk and Modex crashes before its next save, the restart reads the card as uncertain,
  never as sent.
- **Replay** applies the same whole field values, so a frame delivered twice changes nothing, and a
  client that resumes after a decision sees the card answered. A cursor the journal no longer covers
  reloads to a snapshot with the same fields.
- **Late answers** to an answered, uncertain or withdrawn card are refused (`already-resolved` or
  `withdrawn`). Nothing replayed, reloaded or reconnected answers a request.
- **Two clients at once.** The desktop and the phone race through one broker, for approvals and for
  questions: one answer is accepted, the card names who gave it, and the other is refused
  (`already-resolved`), with a 409 for the phone. The CLI hears one answer.
- **The phone** gets `answeredBy` and `delivery` on an open or answered approval. A withdrawn, sending
  or uncertain approval reaches it as a notice that says so ("Request withdrawn. Nothing more can be
  approved."), so the iPhone app no longer shows a withdrawn approval as declined. A question's notice
  says when delivery is uncertain.
- **Who answered** is the client that made the decision: this Mac's window (`desktop`), a desktop
  paired through the host (`paired-desktop`), or the phone. Switching a thread to YOLO answers what is
  waiting as whichever of them switched it.
- **The window** adds "Answered on your phone." or "Answered from a paired desktop." under a card one
  of them answered, and the uncertain line above. An answer given in the window and sent adds nothing.
- **A question closed while a client was away** (CF-6, on the phone answers above). A phone or paired desktop
  that slept while a question was answered, withdrawn by Codex or stopped catches up the way it catches up on
  anything else:
  - **Journal delta.** The phone sends its cursor back and gets the card in the delta, closed, with
    `answeredBy`, `delivery` or `withdrawn`. A phone that draws questions closes its card, and its unsent draft
    goes with it. Drafts for other cards in the thread stay. A phone that does not draw questions gets the
    notice again, with how it closed.
  - **Reload.** A cursor from another journal, ahead of the log or pruned gets the whole transcript, with the
    same card. So does every poll when the journal is off. After an unclean shutdown the journal takes a new
    id, so a phone answer saved inside the 250 ms batch window is never skipped: the old cursor reloads.
  - **No second answer.** A tap queued from before the sleep is refused (`already-resolved` or `withdrawn`);
    the approval route cannot answer a question, and neither can an older paired desktop, which can only
    approve or deny (`invalid`). Codex hears one reply per question.

## Secrets

A secret answer is held only in the turn's memory and written only to the CLI's stdin. It is never in a
saved item, an `item`/`item_update` event, the event journal, a snapshot, the phone's view or an
export. One answered from the phone crosses the paired TLS connection once, in the request body. The
companion hands it to the runner and never logs it or puts it in a reply. The iPhone app keeps it only
in memory until it is sent. Tests check the saved store and the emitted events (`test/human-requests-runner.test.ts`), every
file under `MODEX_HOME` with the journal on and the phone's snapshot (`test/request-journal.test.ts`), and
every file under `MODEX_HOME/app` with the journal off and on (`e2e/human-requests.spec.ts`).

## Repair verification

The repair reproduces local acceptance followed by native withdrawal before the backend resumes.
It also covers Stop, changed backend/account/action/rules, immutable answers, duplicate native IDs,
failed write callbacks, real Writable errors, stdin close before a callback, policy receipts, and
restart rendering. `sent` is always a local write receipt. The offline backend acknowledges consuming
its scripted decision through the same callback boundary.

Installed CLI versions checked on 2026-10-18: `codex-cli 0.163.0` and Claude Code `2.1.289`.
The schemas and scripted fixtures below are source/protocol evidence. A subsequent
[2026-10-20 live check](reviews/2026-10-20-cf3-drafts.md#native-evidence-and-remaining-gates)
passed through the real app with codex-cli 0.163.0 and the opt-in
`default_mode_request_user_input` flag: the card sent Blue and the model replied Blue.
Without that flag, a separate run used `request_user_input_async`, emitted as an async
agent message with questions; that distinct form is not answered by this broker.
Human keyboard/VoiceOver acceptance remains open in #276.
The preview approval gate remains off by default; Never rules, escalation rules, routine refusal,
Ask/Always/YOLO, and permission-profile validation keep their existing decisions.

## Tests

- `test/human-requests.test.ts` covers the pure broker:
  - two clients answering one request;
  - a wrong identity, a changed action, or an unknown id;
  - Stop while an answer is being sent, which makes the request `uncertain`;
  - the Codex mapping, answer validation and secret redaction.
- `test/human-requests-runner.test.ts` covers the runner and the Codex backend:
  - a second answer is refused as `already-resolved`, and the CLI hears one answer;
  - an approval or question answer whose save fails is not taken, and answering again reaches the CLI;
    one whose failed write reached the disk reads as uncertain after a crash;
  - a late answer after Stop is refused as `withdrawn`;
  - a Codex question is answered by its schema, and the secret stays out of saved items and events;
  - Stop sends an error reply;
  - `serverRequest/resolved` withdraws a question with no reply sent;
  - after a restart, open cards are inert, saved and emitted.
- `test/request-journal.test.ts` covers the lifecycle across replay and reconnect, with a real journal,
  paired desktop and phone:
  - who answered and the delivery, in the window, the snapshot, the journal replayed once and twice,
    the phone, and after a restart, with no second decision;
  - simultaneous desktop and phone answers: one accepted, the other refused with a 409;
  - a paired desktop that reconnects after the decision was sent;
  - an expired cursor;
  - a crash between taking an answer and recording its hand-off;
  - a secret answer kept out of every file, event and the phone's view, with the journal on.
- `test/companion.test.ts` covers the phone:
  - the question fallback text for a phone that names no kinds;
  - the card for one that names `question`, with a secret hidden even if the card held it;
  - answers passed to the runner as typed, with `by: "phone"`;
  - `invalid` as a 400 with the runner's text, every other refusal as a 409 with its reason;
  - malformed bodies that reach nothing, and 501 without a broker.
- `test/request-journal.test.ts` also races the desktop and the phone on a real Codex question, each
  answering first. One wins, the loser is refused (a 409 for the phone), Codex hears one answer, and
  the journal and the phone name the winner. A secret answered from the phone reaches Codex and no
  file, event, journal row, phone view or log line. After Stop, a phone answer is refused as
  `withdrawn` and Codex hears only the error reply.
- `apps/ios/ModexCompanion/Tests/CompanionModelTests.swift` (`QuestionCardTests`) covers the iPhone
  model: decoding a card and its closed states, the answers sent (secret whitespace kept, Other text),
  a refusal on the card, a 409 that rereads and drops the closed draft, drafts across threads and
  after forgetting the Mac, nothing in `UserDefaults`, and the item-kinds header. For replay, it checks
  that a journal delta closing one card drops that card's draft and keeps another's, that a withdrawn card
  sends nothing, that a reload replaces the transcript rather than merging into it, and that an uncertain
  answer stays closed.
- `apps/ios/ModexCompanion/UITests/CompanionFlowTests.swift` answers a question in the simulator
  against the real companion and runner (`Scripts/fixture.mjs`). It sends an incomplete answer and
  sees it refused on the card, chooses an option, and types a secret into the secure field. The agent
  then reports the secret matched exactly, and the card reads "Answered on your phone" and shows
  "(hidden)". The fixture keeps an event journal, so the phone polls with its cursor. Two more cards are
  closed on the Mac while open on the phone with a choice made, one answered and one stopped. The next
  poll closes each card ("Answered on your Mac", "Not answered — the turn was stopped") and removes its
  controls, and the agent gets the Mac's answer.
- `test/question-replay.test.ts` covers a question across replay and reconnect on a real Codex app-server
  fixture, journal, companion and paired desktop:
  - answered on the desktop, withdrawn by Codex, or stopped while the phone was away: the delta closes the
    card for a phone that draws it and as a notice for one that does not, taps queued from before the sleep
    get a 409, Codex hears one reply, and the delta, journal and events never hold the secret;
  - cursors from another journal, ahead of the log or pruned, and no journal at all: a full transcript;
  - a paired desktop that slept while the phone answered resumes to the card answered on the phone;
  - a crash inside the batch window after a phone answer: the old cursor reloads, and nothing is sent again;
  - an answer still `sending` at a crash reads as uncertain on both kinds of phone and is never resent;
  - an older paired desktop's approve or deny on a question is refused;
  - a paired desktop that stops reading falls 8 MB behind: the host drops its stream, and its reconnect
    reloads to the answered card.

  Live Codex and Claude runs with the journal on, and the gates that need an iPhone or other platforms, are in
  the [CF-6 gate review](reviews/2026-10-22-cf6-gates.md).
- `test/journal-resume.test.ts` replays one typed turn on every path: a commentary message, a question
  answered on the phone while the desktop slept, and Codex's plan through a failed attempt and its retry.
  The live projection, the saved files, both journals (live and coalesced, each also replayed twice), the
  paired desktop and both kinds of phone (full snapshot against mid-run snapshot plus delta) agree.
- `test/conversation-migration.test.ts` loads questions and a plan as v0.3.0 saved them: the open one closes
  as `ended`, older answers gain no invented sender or delivery, and the draft file is byte-identical.
- `test/turn-layout.test.ts` checks that an open question never folds away.
- `e2e/human-requests.spec.ts` runs a fixture Codex app-server through the real UI:
  - the turn header while a question waits;
  - an incomplete answer is refused in place;
  - the password field and unsent choices/text retained across thread navigation;
  - one reply carrying the answers;
  - a refused second answer;
  - Stop gives an error reply;
  - no secret on disk;
  - with the journal on, a restart after a crash mid-send: answered and stopped cards are inert, the
    uncertain one says so, and Codex hears nothing more.

## Not done here

- Clarifying a task plan through a question card (the second half of CF-7).
- Human acceptance of a native question (keyboard, VoiceOver, iPhone): [steps](reviews/2026-10-22-cf3-question-acceptance.md),
  tracked in #281.
