# OpenCode and MiMo Code backends

Modex drives [OpenCode](https://opencode.ai) and [MiMo Code](https://github.com/XiaomiMiMo/mimo-code)
(Xiaomi's fork of OpenCode, binary `mimo`) the same way it drives Claude Code and Codex: through
the CLI the person already installed and signed in to. Both expose the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP) over `opencode acp` / `mimo acp`:
newline-delimited JSON-RPC on stdio, the protocol Zed and other editors use. One backend class,
`apps/desktop/src/main/engine/backends/acp.ts`, serves both; the family only changes the binary,
the config variable and the words in notices. Issue [#408](https://github.com/TypeSafeAI/modex/issues/408).

Accepted on OpenCode 1.19.5 and MiMo Code 0.1.16 on macOS, 2026-10-28, with the raw ACP probes in
[2026-10-28-opencode-acp.json](reviews/2026-10-28-opencode-acp.json) and
[2026-10-28-mimo-acp.json](reviews/2026-10-28-mimo-acp.json), and the compiled backend driving the
real OpenCode in [2026-10-28-opencode-backend-live.json](reviews/2026-10-28-opencode-backend-live.json):
a text turn, a Chat-mode shell command denied through the approval path, an Agent-mode write without
a prompt, and Stop confirmed 17 ms after the cancel.

## How a turn runs

1. **One server per backend.** The first turn starts `<cli> acp --pure` once, detached in its own
   process group. `--pure` keeps the CLI's plugins and hooks out of the server. Modex's
   configuration travels inline in `OPENCODE_CONFIG_CONTENT` / `MIMOCODE_CONFIG_CONTENT`, which the
   CLI merges on top of the person's own `opencode.json`; nothing is written to disk and the person's
   providers, models, MCP servers and agents stay. It disables the CLI's self-update and its
   transcript sharing. `initialize` offers no `fs` or `terminal` capability, so the CLI reads and
   runs through its own tools and never asks Modex to.
2. **A session per thread.** `session/new` in the thread's cwd; the session id is the thread's
   resume handle. A later turn reopens it with `session/resume` (no replay) when the CLI offers it,
   else `session/load` with the replayed history discarded. A session the server no longer knows
   starts afresh with a notice.
3. **Mode first.** `session/set_mode` picks the agent below; a refused mode fails the turn, so a
   turn never runs looser than asked. Then `session/set_config_option` sets the thread's model
   (a refusal is a warning; the session's current model runs) and effort (informational).
4. **The prompt.** `session/prompt` with the text and any image attachments inline
   (`promptCapabilities.image`). Updates stream as `agent_message_chunk`, `agent_thought_chunk`,
   `tool_call`, `tool_call_update` and `plan`; the result's `stopReason` and `usage` end the turn.
   Stop sends `session/cancel`; the prompt then answers `cancelled` (16 ms live) and the turn is
   interrupted. Only a second Stop kills the shared server.

## Modes are agents

OpenCode's permissions live on agents, and ACP exposes agents as session modes. The inline config
adds three primary agents and pins the built-in `plan` agent, so each Modex mode is a permission
table the model cannot talk its way around:

| Modex mode | ACP mode | edit | bash | task (subagents) | external_directory | webfetch |
| --- | --- | --- | --- | --- | --- | --- |
| Chat | `modex-chat` | deny | ask | deny | ask | allow |
| Plan | `plan` (built-in, pinned) | deny | ask | deny | ask | allow |
| Agent | `modex-agent` | allow | ask | allow | ask | allow |
| Full access | `modex-full` | `*`: allow | | | | |

`ask` becomes a `session/request_permission` request. Modex maps it to its approval card and rules:
an `execute` call is the `shell` tool with a `$ command` title, an `edit` call carries its path and
never the content, and the answer is the request's own option (`allow_once`, `allow_always`, or
the reject option). The approval gate, the thread's approval policy and exact-match rules
(`shell: npm test*`) work as for Claude and Codex. `allow_always` is honoured by the CLI for that
session only.

Live, on 1.19.5: a `modex-chat` write was refused by the CLI without asking and the model answered
`WRITE_BLOCKED`; a `modex-chat` shell command asked and, rejected, ended as a denied tool call; a
`modex-agent` write ran without asking; a `modex-full` shell command ran without asking; a `plan`
write was refused. MiMo Code 0.1.16 lists the same agents as modes and accepts `set_mode`.

## Health and models

Settings runs two bounded probes: `--version` and `auth list`, whose credential count is the
sign-in status. OpenCode's own free models answer without a credential, so "No credentials" is a
hint there, not a block; MiMo Code with no credentials ends a turn with no text and no tokens, which
Modex reports as a turn that ended without a reply. The model list is `<cli> models`
(`provider/model` ids); it carries no efforts or service tiers, so Auto routing ranks these
models by its generic rules. Overrides for the executables are verified with `--version`
(a bare semantic version on both CLIs) before they are saved. Sign-in stays in a terminal
(`opencode auth login`, `mimo auth login`); Modex never sees a credential.

## What is not there

- **No confined review mode.** Code Review (CR-6) turns are refused; they run on Claude.
- **No Modex MCP tools.** Knowledge, Space pages and image tools are not attached; their
  instructions go in as text with a notice, and the agent cannot call them.
- **No questions.** The CLI's elicitation is not wired to Modex's question cards; a question
  arrives as ordinary text.
- **No per-turn fast mode or efforts in the model list.** Effort is set when the model's
  config option exists and is otherwise ignored.
- **Cache measurements.** Nothing has been measured for prompt-cache behaviour across the
  providers these CLIs route to, so Auto assumes an effort or fast change clears it.
- **Network.** The CLIs reach their configured providers and OpenCode's free-model gateway as
  they do from a terminal. Modex adds no network call of its own.
