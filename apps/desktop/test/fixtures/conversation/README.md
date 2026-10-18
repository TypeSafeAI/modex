# Conversation fixtures

Sanitized protocol captures for the conversation-event contract
([docs/conversation-events.md](../../../../../docs/conversation-events.md)). They are recorded output
from real CLI runs, replayed by `test/conversation-events.test.ts`. They are not live-provider
acceptance: a test that passes on them says the adapters read these bytes correctly, nothing about
today's models.

Captured on 2026-10-18 on macOS (Apple Silicon) with `sanitize.mjs` applied afterwards.

| File | CLI | Model | What the turn did |
| --- | --- | --- | --- |
| `claude-2.1.302-haiku-interleave.jsonl` | Claude Code 2.1.302, `claude -p` stream-json with partial messages and the stdio permission prompt | claude-haiku-5-5 | Thinking block with no text (signature only), text, `echo one` (allowed), text, `touch denied.txt` (denied by the driver), final text `Done ha ha ha.` |
| `codex-0.163.0-interleave.jsonl` | codex-cli 0.163.0, `codex app-server` over stdio, read-only sandbox, approval policy `untrusted` | gpt-6-astra, effort low | Commentary `Checking one — café ✓.`, `echo one` (accepted), commentary `Checking two.`, `touch denied.txt` (declined), final answer `Done ha ha ha.` |
| `codex-0.163.0-reasoning.jsonl` | codex-cli 0.163.0 | gpt-6-astra, effort high | One reasoning item with one summary part and no reasoning text, then a final answer. |
| `codex-0.163.0-interrupt.jsonl` | codex-cli 0.163.0 | gpt-6-astra, effort low | A reasoning item with no summary or text; the final answer streams eight deltas, then `turn/interrupt`: the message never completes and the turn ends `interrupted`. |
| `codex-0.163.0-protocol.json` | codex-cli 0.163.0 `app-server generate-json-schema` | — | The native enums and notification fields the Codex mappings use. |

What the captures established, which the contract relies on:

- **Codex.** Every `item/*` notification carries `threadId` and `turnId`. `agentMessage` items carry
  `phase` (`commentary`, `final_answer`; the schema also has `partial_answer`, and `null` means
  unknown). Each message in a turn has its own item id, but ids share long prefixes. Reasoning
  summary deltas carry `summaryIndex`; reasoning text deltas carry `contentIndex`. A reasoning item
  can complete with empty `summary` and `content`. A declined command completes with status
  `declined` and `exitCode: null`. An interrupted turn leaves its streaming message without
  `item/completed`.
- **Claude.** Each content block is identified by `message.id` and its stream `index`; the CLI
  sends one `assistant` message per block, before that block's `content_block_stop`, and every line
  has its own `uuid`. Haiku 5.5's thinking arrived with empty `thinking` text and only a signature
  (`thinking_display: "updates"`). A denied tool comes back as a `tool_result` with `is_error: true`
  and is listed in the result's `permission_denials`; the `control_request` names its
  `tool_use_id`. Claude reports no message phase.

## Regenerating

Run the CLI against a scratch directory, record its stdout verbatim, then:

```sh
node sanitize.mjs claude raw.jsonl claude-<version>-<name>.jsonl <capture cwd>
node sanitize.mjs codex raw.jsonl codex-<version>-<name>.jsonl <capture cwd>
codex app-server generate-json-schema --out schema
node sanitize.mjs codex-protocol schema/codex_app_server_protocol.v2.schemas.json codex-<version>-protocol.json <version>
```

Check the output for local paths, account names and anything opaque before committing it.
