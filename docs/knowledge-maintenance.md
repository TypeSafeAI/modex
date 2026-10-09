# Agent knowledge maintenance

Choose a knowledge folder and install OpenKnowledge in **Space → Knowledge base**.
Claude and Codex threads can search and read it from any project or worktree. Modex
starts the companion when a coding turn needs the connection.

Expand **Agent maintenance** and enable a project to let its agents save verified
decisions, fixes and procedures automatically. The setting defaults to off and
survives restarting Modex. Chat and plan turns remain read-only. Turning the setting
off denies subsequent writes, including calls from a running turn; an operation
already sent to the companion can still complete.

Agents receive maintenance instructions with each turn: search before creating a
page, read before editing, preserve human content, prefer targeted edits, include
source links and verification dates, and report which pages changed. These
instructions guide the model; a turn with no durable finding need not write a page.

Successful writes add a saved **Knowledge updated** receipt to the thread. Click its
page button to open the local OpenKnowledge editor in your browser. The same content
appears in the embedded editor in Space. OpenKnowledge owns the attributed history
and recovery controls. Receipts survive reloads; if you select a different knowledge
folder, an old receipt asks you to select its original folder before opening it.

## Integration boundary

`KnowledgeAgents` runs a loopback MCP adapter in Electron main. Its five tools are
`search`, `read`, `write`, `edit`, and `history`. Calls go to the separately installed,
pinned OpenKnowledge 0.83.2 companion through its MCP server. Agent writes use its
collaborative document operations, never direct filesystem writes. Search forces
lexical mode; Modex does not request semantic embedding services.

The adapter fixes the knowledge root and accepts only relative Markdown document
paths. It rejects traversal, symlinks, hidden metadata and reserved editor routes.
It exposes no global skill operations, arbitrary shell execution, file preview,
delete, or restore tool. Recovery stays in the existing knowledge editor.

Each Modex thread has a stable, unguessable local endpoint. Tool discovery remains
available between turns, while document calls require an active turn. Each operation
rechecks the current folder/server and project permission; chat and plan turns cannot
write. Ending or stopping a turn revokes its access. Already-dispatched operations
are drained so their actual outcomes can be recorded. Failed or timed-out writes
are not automatically retried.

Claude receives session-local MCP configuration and appended instructions. Codex
receives per-thread MCP configuration on start or fresh resume and instructions on
every turn. A loaded Codex thread does not replace MCP settings on resume, so the
adapter updates its authorization without changing the endpoint. No global CLI
configuration or repository agent files are modified. Models still run exclusively
through the existing coding CLIs.

Both backends preapprove only the adapter's five tools; Modex checks the actual
permission on each call. A read-only turn cannot gain write access if its mode is
changed during setup or execution. Stop cancels companion startup waits and the
entire MCP handshake without waiting for a server that has stopped responding.

## Verification

Run `npm run build && npm test`, `npm run typecheck`, and `npm run test:e2e`.
To include real-companion checks, set `MODEX_TEST_OPEN_KNOWLEDGE=1`. The new adapter
integration and CLI-to-editor test use the runtime at
`~/.modex/integrations/open-knowledge`, overridable with
`MODEX_OPEN_KNOWLEDGE_RUNTIME`. They create disposable knowledge folders. Other
existing knowledge E2E tests exercise installation into their isolated homes.
