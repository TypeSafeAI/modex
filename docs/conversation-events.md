# Conversation events

How a coding turn's assistant text, reasoning and tool work travel from a native CLI into the
transcript, with their identity intact. This is the contract from
[#274](https://github.com/TypeSafeAI/modex/issues/274) (CF-1 of tracker
[#273](https://github.com/TypeSafeAI/modex/issues/273)). Rendering, human requests, replay and task
evidence (CF-2 to CF-8) build on it.

The code is `apps/desktop/src/shared/conversation-events.ts`. It is pure and serializable, so main,
the renderer and paired clients can all use it.

## What changed

Before, a backend reported a turn through untyped callbacks: `delta(text)`, `assistant(text)`,
`thinkingDelta(id, text)` and the like. The runner kept one "streaming" buffer, so two messages
whose deltas interleaved merged into one. Codex reasoning summaries and reasoning text were joined
into one string. A tool left open when a stream ended was saved as failed. A credit-fallback retry
reused the first attempt's sink, so a late delta from the first run could change the second.

Now a backend reports everything through one method, `TurnSink.observe(observation)`. Each
observation names the native item it belongs to. The runner stamps it and folds it into transcript
items with `applyConversationEvent`.

Coding turns still run only through `codex app-server` and `claude -p`; nothing here executes
anything, replays an action or talks to a provider.

## Identity

```ts
interface NativeRef {
  runtime: string;   // opaque id Modex gives each CLI process or app-server it starts
  thread?: string;   // Codex thread id; Claude session id
  turn?: string;     // Codex turn id (Claude reports none)
  item: string;      // Codex item id; Claude message id, or tool_use id
  part?: string;     // Claude content-block index
}

interface TurnRef {
  thread: string;    // Modex thread id
  turn: string;      // Modex turn: the id of the user message being answered
  attempt: string;   // one run of the backend for this turn
  backend: BackendId;
  account?: string;  // opaque account binding ("cli" or a ChatGPT registration id); never a credential
}

interface ItemOrigin extends TurnRef { native: NativeRef }
```

- Native ids are unique only within their runtime. The projector keys every native item by thread,
  account, attempt, runtime, native thread, native turn, item and part, so a reused id never
  collides. Codex's runtime is the app-server process: Modex mints a new one each time it starts a
  server, including the restart after a stale ChatGPT sign-in. Claude's is the `claude -p` process.
  Each account-bound Codex registration runs its own app-server, so its runtime differs too.
- **Turn.** The Modex turn is the user message. Retry runs the same turn again without a new user
  message. Claude's follow-up turns after background work, and any future steering, stay inside
  the Modex turn; a native turn boundary is never taken as a new Modex turn.
- **Attempt.** Each run of the backend is a new attempt: the first run, a Retry, and the
  credit-fallback rerun. Starting an attempt makes every earlier attempt's sink inert: its
  observations, notices, approvals and resume handle are all ignored. The projector also ignores any
  observation that is not for its turn's current, running attempt.

## Values

These are Modex's design values. Adapters map native values onto them (tables below); a native
value with no mapping stays unspecified, unavailable or unknown, never guessed.

| Field | Values | On |
| --- | --- | --- |
| `MessagePhase` | `commentary`, `final`, `unspecified` | assistant items (`phase`; the CLI's own value in `nativePhase`) |
| `ReasoningRepresentation` | `summary`, `provider-text`, `unavailable` | thinking items (`reasoning`) |
| `ExecutionOutcome` | `running`, `succeeded`, `failed`, `denied`, `interrupted`, `unknown` | assistant, thinking and tool items (`outcome`) |

- `summary` is a summary the provider publishes as such. `provider-text` is reasoning text the
  provider sent in the clear, with no claim that it is a summary. `unavailable` means the model
  reasoned but no readable text came: omitted, redacted or opaque. A summary and provider text are
  never joined: each representation of one reasoning item is its own transcript item. Opaque
  payloads (Claude signatures, `redacted_thinking` data, Codex encrypted content) are never read,
  stored or shown.
- An outcome describes one piece of work. A message completing is not the turn completing; the
  turn's own result ends its attempt (`attempt.end`). A connection going idle or away establishes
  no outcome: work left open when an attempt ends becomes `interrupted` if the attempt was
  interrupted, otherwise `unknown`.
- Tool items keep `ok` for older readers: `true` only for `succeeded`, `false` only for `failed`
  or `denied`, and absent otherwise.

## Observations and events

```ts
type Observation = (
  | { type: "message.start"; native: NativeRef; phase: MessagePhase; nativePhase?: string }
  | { type: "message.delta"; native: NativeRef; text: string }
  | { type: "message.done"; native: NativeRef; text?: string; phase?: MessagePhase; nativePhase?: string }
  | { type: "reasoning.start"; native: NativeRef }
  | { type: "reasoning.delta"; native: NativeRef; representation: "summary" | "provider-text"; index: number; text: string }
  | { type: "reasoning.done"; native: NativeRef; summary?: string[]; text?: string[] }
  | { type: "tool.start"; native: NativeRef; tool: ToolCall }
  | { type: "tool.update"; native: NativeRef; progress: ToolProgress }
  | { type: "tool.done"; native: NativeRef; outcome: SettledOutcome; progress?: ToolProgress }
) & { source?: string };

type AttemptMark = { type: "attempt.start" } | { type: "attempt.end"; outcome: SettledOutcome };

type ConversationEvent = (Observation | AttemptMark) & {
  schema: 1;
  id: string;     // the CLI's event id when it gave one ("<runtime>:<source>"), else "<attempt>:<seq>"
  seq: number;    // ingress order within the attempt, from 1
  at: string;     // ingress time
  turn: TurnRef;
};
```

Backends make observations; only the runner makes `AttemptMark`s and stamps events.
`message.done.text` and the `reasoning.done` arrays are final snapshots: they replace what
streamed rather than adding to it. `ToolProgress.output` is the whole output so far.

## The projector

```ts
function initialConversation(): ConversationState;
function applyConversationEvent(state: ConversationState, event: ConversationEvent): ConversationState;
function projectConversation(events: readonly ConversationEvent[], state?: ConversationState): ConversationState;
function parseConversationEvent(value: unknown): ConversationEvent | null;
function itemFacts(item: ThreadItem): ItemFacts;
function finalAnswerIndex(items: readonly ThreadItem[]): number;
function okFor(outcome: ExecutionOutcome): boolean | undefined;
```

`ConversationState` holds the projected items (`ConversationItem`, each a `ThreadItem` with
`origin` and `outcome`), the current attempt and outcome per turn, a cursor per attempt, and
per-native-item bookkeeping. It is plain JSON.

`applyConversationEvent` is pure. It returns the same object when an event changes nothing.

- Events of one attempt apply in `seq` order. An event at or below the attempt's cursor is a
  duplicate and changes nothing, so applying a log twice, or one event twice, is harmless.
- Text is never deduplicated by content. Three `" ha"` deltas are three tokens.
- A message shows nothing until it has text, as before; a start without text, or an empty
  completion, adds no item. A reasoning start shows a Thinking row at once.
- Reasoning parts join in index order with a blank line, per representation.
- Items keep ingress order: an item takes its place when it first has content.

`parseConversationEvent` checks an event read from outside the process (a file, a paired client)
and returns null when it is malformed.

## The runner

`ThreadRunner` starts one attempt per backend run (`beginAttempt`). Its sink stamps each
observation and applies it to the turn's state, then emits whatever changed as the existing
`item` and `item_update` thread events. The events carry whole field values, as the
[event journal](event-journal.md) requires, so the journal, its replay and paired clients need no
change for this contract. Streaming deltas and tool updates are written to disk at most every
250 ms; everything else is written at once, as before.

- A CLI event id is applied once per attempt: Claude gives every stream line a `uuid`, and a
  repeated line is the same event.
- `attempt.end` follows the backend's result: completed → `succeeded`, interrupted (or Stop) →
  `interrupted`, failed or thrown → `failed`.
- Tool args are truncated for the UI before they are stamped, as before.
- On load, an item a previous process saw start but never end (`outcome: "running"`) becomes
  `unknown`, and its spinner stops.

## Native mappings

### Codex (`codex app-server`, codex-cli 0.163.0)

| Native | Observation |
| --- | --- |
| `item/started` `agentMessage` | `message.start`, phase from `phase` |
| `item/agentMessage/delta` | `message.delta` |
| `item/completed` `agentMessage` | `message.done` with `text` as the snapshot. A message that completes without streaming is kept, commentary included (before, an unstreamed commentary message was dropped). |
| `item/started` `reasoning` | `reasoning.start` |
| `item/reasoning/summaryTextDelta` | `reasoning.delta`, `summary`, index `summaryIndex` |
| `item/reasoning/textDelta` | `reasoning.delta`, `provider-text`, index `contentIndex` |
| `item/reasoning/summaryPartAdded` | nothing: parts are keyed by index |
| `item/completed` `reasoning` | `reasoning.done` with `summary` and `content` as snapshots |
| `item/started` `commandExecution`, `fileChange`, `mcpToolCall`, `dynamicToolCall`, `webSearch` | `tool.start` |
| (`fileChange`) | `apply_patch` with `args.patch` (the diffs, joined) and `args.files` (each file's `path`, `kind`, `movePath`, and `lines` of `patch`; [evidence](conversation-evidence.md)) |
| `item/commandExecution/outputDelta` | `tool.update` |
| `item/completed` for those tools | `tool.done` |
| collaboration and sub-agent items | `tool.*` for `agent:<thread id>` |

Every observation's `NativeRef` carries the app-server's runtime, the Codex thread id, the Codex turn
id and the item id.

| `phase` | `MessagePhase` |
| --- | --- |
| `commentary` | `commentary` |
| `final_answer` | `final` |
| `partial_answer` | `unspecified` (neither commentary nor the final answer; kept in `nativePhase`) |
| `null` | `unspecified` |

| Tool `status` | `ExecutionOutcome` |
| --- | --- |
| `declined` | `denied` |
| `failed` | `failed` |
| `completed`, command with exit code 0 | `succeeded` |
| `completed`, command with another exit code | `failed` |
| `completed`, command with no exit code | `unknown` |
| `completed`, any other tool | `succeeded` |
| `inProgress` when the item completes | `unknown` |
| no status, a command with an exit code | from the exit code |
| no status (web search), no error | `unknown` |
| no status, an error | `failed` |

`turn/completed` ends the turn: `completed`, `interrupted` and `failed` become the attempt's
outcome. `thread/status/changed` describes the connection and never ends anything.

### Claude (`claude -p --output-format stream-json`, Claude Code 2.1.302)

A content block is named by `message.id` and its stream `index`. The CLI sends one `assistant`
message per block, in stream order and before that block's `content_block_stop`, so the k-th
block of a message id is stream block k. Each observation's `source` is the line's `uuid`,
numbered when one line makes several.

| Native | Observation |
| --- | --- |
| `content_block_start` `text` | `message.start`, phase `unspecified` (Claude reports no phase) |
| `text_delta` | `message.delta` |
| `assistant` text block | `message.done` with the block's text as the snapshot |
| `content_block_stop` of a text block | `message.done` (no snapshot) |
| `content_block_start` `thinking` / `redacted_thinking` | `reasoning.start` |
| non-empty `thinking_delta` (or the start's text) | `reasoning.delta`: `summary` when the message's `thinking_display` is `summarized`, otherwise `provider-text` |
| `content_block_stop` of a thinking block | `reasoning.done` |
| `signature_delta`, `redacted_thinking` data | nothing; never read |
| `assistant` thinking block not seen streaming | `reasoning.start`, its text if any, `reasoning.done` |
| `assistant` `tool_use` block | `tool.start` (`agent:<id>` for Agent and Task) |
| `tool_result` | `tool.done`: `succeeded`; `denied` when `is_error` and Modex refused that `tool_use_id`; `failed` otherwise |
| sub-agent lines (`parent_tool_use_id`) | the agent's own row only, as before |

A thinking block whose text is empty (Haiku 5.5 sends only a signature, with
`thinking_display: "updates"`) stays `unavailable`. `thinking_display` rides on `message_start` and
every line after it, so the representation is known before any text streams. Claude Code 2.1.302
accepts `summarized`, `omitted` and `highlights` as display modes; only `summarized` claims a
summary. No live capture has yet shown thinking text: the summarized case is tested on a synthetic
stream.

### The offline engine and scripted backends

`backends/local-items.ts` (`LocalItems`) adapts engines that report text without ids: the mock
backend, the Images fixture and the tests' scripted backends. One message streams at a time and
its id is assigned at ingress. A tool or reasoning block ends the message before it, as the
runner's single buffer used to. Its reasoning is `provider-text`. A tool settles from `ok`:
`true` succeeded, `false` failed, absent unknown.

## Transcript items

Assistant, thinking and tool items gain optional `origin` and `outcome` fields, assistant items
`phase` and `nativePhase`, and thinking items `reasoning`. The fields are additive: state files,
the journal and older paired clients read them as before, and journal-disabled mode is unchanged.

Items saved before this contract have none of them. Read every item through `itemFacts`, the
explicit legacy adapter: an old item keeps its text and gets no invented provenance. Its phase is
`unspecified`, its outcome `unknown`, except a tool that recorded `ok: true`, which only a
backend's success report ever set. `finalAnswerIndex` keeps the historical heuristic, the last
assistant item, for turns without typed phases (old history, Claude, older Codex models). A turn
whose messages have typed phases answers with its last `final` message, or has no final answer.

The renderer change is for compatibility only. A finished tool's status reads Done, Failed,
Denied, Stopped or Status unavailable from its outcome, never Done for an unknown. A turn folds its
work up to its final answer, by `finalAnswerIndex`.

## For the issues that build on this

- **Rendering (CF-4).** `shared/turn-layout.ts` (`layoutTurn`) lays a turn out from these fields:
  the latest attempt's `final` message answers, every `running` item is live, a later attempt opens
  with a divider, and only work that succeeded folds under the turn header. Items saved before the
  contract keep the last-reply heuristic there. A reasoning row is tagged Summary or Not shared;
  `provider-text` shows untagged.
- **Interruption and requests (CF-2, CF-3).** Approvals are still separate transcript items. A Claude
  denial is attributed through the `tool_use_id` of the refused `control_request`.
- **Replay and paired clients (CF-6).** Conversation events are not stored: the journal records the
  item events they produce, with the typed fields as whole values. `replayItems` upserts by id, the
  phone receives the typed fields, and work left running at a restart is settled everywhere. See
  [Typed conversation state](event-journal.md#typed-conversation-state). `parseConversationEvent`
  and the deterministic projector are there for a future event store.

## Evidence attached to items

`message.done` can carry `evidence` (a Codex memory citation). `tool.start` can carry `exec` (the
command that ran and, when reported, its cwd). `tool.update` and `tool.done` progress can carry
`exitCode`, `outputBytes` and `outputTruncated`. See [conversation-evidence.md](conversation-evidence.md).

## Evidence

`apps/desktop/test/conversation-events.test.ts` replays sanitized captures from Claude Code 2.1.302
(Haiku 5.5) and codex-cli 0.163.0 through the real adapters and the runner, and tests the
projector directly. See the fixtures' [README](../apps/desktop/test/fixtures/conversation/README.md).
The captures show how these CLI versions behaved on the capture date; they are not live-provider
acceptance.
