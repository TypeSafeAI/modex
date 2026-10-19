# Human requests

How a CLI's approvals and questions reach a person and how their answers go back, exactly once. This
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

`uncertain` means an answer was accepted but the request went away before the send was recorded, so
whether the CLI received the answer is unknown. It never reads as resolved. Today's backends hand an
accepted answer to the CLI's stdin in the same tick, so the runner records `sent` at once. The state
exists for transports where the hand-off can fail after acceptance.

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
  digest when it resolves.
- **Questions.** `TurnSink.question(req, withdrawn?)` adds a `question` card. A blocking question
  sets the thread to `waiting`; a non-blocking one lets the turn run on. `answerQuestion` validates
  the answers and gives `error` text for an invalid one (for example "Token needs an answer.").
  Only then does anything reach the CLI. The card saves `publicAnswers`.
- **Withdrawal.** `withdraw(threadId, l, itemId, "native" | "stopped" | "ended")` closes a card
  once. An approval closes as `answer: "no"` plus `withdrawn`, so older clients show it closed. A
  question closes with `withdrawn` alone, and its sink settles with `{ withdrawn }`, never with empty
  answers.
- **Restart.** When a thread first loads in a new process, any approval without an answer and any question
  without answers or a withdrawal is closed as `withdrawn: "ended"`. The change is saved, and emitted as
  `item_update`, so the journal and paired clients see it too.
- **Routines.** An unattended routine has nobody to ask. Approvals are refused with a receipt, as
  before. Questions are declined with a warning notice.

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

  A refusal is shown on the card. An answered card lists the answers, with a secret one shown as
  "(hidden)". A closed card says why, in the approval card's words. While a question waits, the turn
  header reads "Waiting for your answer" instead of "Waiting for approval". An answered or closed card
  folds into the turn's work like an answered approval; an open one never does.
- **Phone.** The companion still answers approvals only. It refuses an answer to anything that is not an
  open approval, and a runner refusal becomes a 409. A question reaches the phone as an `info` notice
  that carries the question text and its state ("Answer it in Modex on your Mac.", "Answered on your
  Mac.", "Not answered."), never the answers.
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
- **Replay** applies the same whole field values, so a frame delivered twice changes nothing, and a
  client that resumes after a decision sees the card answered. A cursor the journal no longer covers
  reloads to a snapshot with the same fields.
- **Late answers** to an answered, uncertain or withdrawn card are refused (`already-resolved` or
  `withdrawn`). Nothing replayed, reloaded or reconnected answers a request.
- **Two clients at once.** The desktop and the phone race through one broker: one answer is accepted,
  the card names who gave it, and the other is refused, with a 409 for the phone.
- **The phone** gets `answeredBy`, `delivery` and `withdrawn` on approvals. Today's iPhone build reads
  only `answer`, so a withdrawn approval still reads as declined there. A question's notice says when
  delivery is uncertain.
- **Who answered** is the client that made the decision: this Mac's window (`desktop`), a desktop
  paired through the host (`paired-desktop`), or the phone. Switching a thread to YOLO answers what is
  waiting as whichever of them switched it.
- **The window** adds "Answered on your phone." or "Answered from a paired desktop." under a card one
  of them answered, and the uncertain line above. An answer given in the window and sent adds nothing.

## Secrets

A secret answer is held only in the turn's memory and written only to the CLI's stdin. It is never in a
saved item, an `item`/`item_update` event, the event journal, a snapshot, the phone's view or an
export. Tests check the saved store and the emitted events (`test/human-requests-runner.test.ts`), every
file under `MODEX_HOME` with the journal on and the phone's snapshot (`test/request-journal.test.ts`), and
every file under `MODEX_HOME/app` with the journal off and on (`e2e/human-requests.spec.ts`).

## Tests

- `test/human-requests.test.ts` covers the pure broker:
  - two clients answering one request;
  - a wrong identity, a changed action, or an unknown id;
  - Stop while an answer is being sent, which makes the request `uncertain`;
  - the Codex mapping, answer validation and secret redaction.
- `test/human-requests-runner.test.ts` covers the runner and the Codex backend:
  - a second answer is refused as `already-resolved`, and the CLI hears one answer;
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
- `test/companion.test.ts` covers the phone: the question fallback text, and refusals as 409.
- `test/turn-layout.test.ts` checks that an open question never folds away.
- `e2e/human-requests.spec.ts` runs a fixture Codex app-server through the real UI:
  - the turn header while a question waits;
  - an incomplete answer is refused in place;
  - the password field;
  - one reply carrying the answers;
  - a refused second answer;
  - Stop gives an error reply;
  - no secret on disk;
  - with the journal on, a restart after a crash mid-send: answered and stopped cards are inert, the
    uncertain one says so, and Codex hears nothing more.

## Not done here

- Answering questions from the phone.
- Clarifying a task plan through a question card (the second half of CF-7).
