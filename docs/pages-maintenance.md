# Agent notes in Space

Modex includes its own local Pages MCP server. Claude and Codex use it to manage the same notes you edit in **Space**, without an OpenKnowledge installation, remote account or global CLI configuration.

Open Space, expand **Agent notes**, and enable **Manage notes for <project>**. This grants that project's agents access to all notes in this Modex home. It starts disabled for every project. Disable it to revoke access immediately. Chat and plan turns can read enabled notes but cannot change them.

Ask an agent to find, create, update or organize your notes. It searches before creating, reads before editing, and uses targeted replacements to preserve your writing. Each successful change produces a thread receipt that opens the note. Space refreshes changes while keeping unsaved drafts intact.

## Tools

The session-local server is named `modex_pages` and exposes:

- `search`: title/content search, including an optional Trash filter and pagination.
- `read`: full note, metadata and current revision.
- `create`: title, Markdown and optional parent page.
- `edit`: replace one unique text match; an empty match fills an empty note.
- `update`: rename, move or favorite a note.
- `trash` / `restore`: recoverable note-tree removal and restoration.
- `history` / `revert`: inspect attributed versions and recover one as a new revision.

Mutations require a short summary. Changes to existing notes also require the revision returned by `read`; a concurrent edit rejects the stale request. Agents must read again and reconcile instead of retrying blindly. Moving, trashing or reverting pages requires user intent in the injected maintenance instructions. There is no permanent-delete tool.

## Recovering changes

Use **Page actions → Version history** to inspect previous content and restore a revision. Restore a trashed note from **Trash** before editing it. History groups continuous human typing into 30-second checkpoints and records every explicit agent change with its responsible thread. The original note and the version before each agent change remain recoverable; revision numbers may skip between typing checkpoints.

If your unsaved draft conflicts with an agent edit, the editor keeps your text and reports the conflict. **Save drafts as copies and reload** preserves those drafts as new top-level notes and loads the saved versions. The editor is locked while those copies are saved.

Notes and their journal are stored atomically in `MODEX_HOME/app/space.json`. The first change upgrades an older version-1 file to version 2 and preserves existing notes as baseline versions. Older Modex builds cannot read version 2; keep a backup if you need to downgrade. Notes can still be exported as Markdown.

## Access boundary

The server binds only to loopback, rejects browser-origin requests, and uses an unguessable route for each thread. The route stays stable when a CLI resumes the thread, but access exists only during an active turn. Permissions are checked on every call. Turning chat or plan mode off during a running turn cannot grant write access to that turn. Stopping a turn revokes the route. Requests are bound to the turn that received them, including requests whose bodies arrive after a later turn begins.

Only note operations are exposed: no filesystem, shell, arbitrary URL or inference API. The MCP connection and its tool allowlist are passed to the coding CLI for that session. Knowledge base maintenance remains a separate setting and server.
