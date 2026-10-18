# Agent notes in Space

Modex includes its own local Pages MCP server. Claude and Codex use it to manage the same notes you edit in **Space**, without an OpenKnowledge installation, remote account or global CLI configuration.

In Space, choose **Space options → Agent notes**, and enable **Manage notes for <project>**. This grants that project's agents access to that project's own notes (its folder in Space), and to nothing outside them. It starts disabled for every project. Disable it to revoke access immediately. Chat and plan turns can read enabled notes but cannot change them.

Ask an agent to find, create, update or organize your notes. It searches before creating, reads before editing, and uses targeted replacements to preserve your writing. Each successful change produces a thread receipt that opens the note. Space refreshes changes while keeping unsaved drafts intact.

## Tools

The session-local server is named `modex_pages` and exposes:

- `search`: title/content search, including an optional Trash filter and pagination.
- `read`: full note, metadata and current revision.
- `create`: title, Markdown and optional parent page; without one, the note goes at the top of the project's notes.
- `edit`: replace one unique text match; an empty match fills an empty note.
- `update`: rename, move or favorite a note.
- `trash` / `restore`: recoverable note-tree removal and restoration.
- `history` / `revert`: inspect attributed versions and recover one as a new revision.
- `list`: what a folder of the project's notes holds (folders, notes, files), with IDs.
- `create_folder` / `move`: make a folder, or move a note or folder within the project's notes.
- `read_file`: a text file (UTF-8, up to 1 MB) from the project's notes.

Every tool stays inside the turn's project: another project's notes are not listed, read or
changed, and nothing can be moved out. There are no tools for binary files or permanent
deletion. Codex threads already running keep the tools their session started with until the
app-server restarts.

Mutations require a short summary. Changes to existing notes also require the revision returned by `read`; a concurrent edit rejects the stale request. Agents must read again and reconcile instead of retrying blindly. Moving, trashing or reverting pages requires user intent in the injected maintenance instructions. There is no permanent-delete tool.

## Recovering changes

Use **Page actions → Version history** to inspect previous content and restore a revision. Restore a trashed note from **Trash** before editing it. History groups continuous human typing into 30-second checkpoints and records every explicit agent change with its responsible thread. The original note and the version before each agent change remain recoverable; revision numbers may skip between typing checkpoints.

If your unsaved draft conflicts with an agent edit, the editor keeps your text and reports the conflict. **Save drafts as copies and reload** preserves those drafts as new top-level notes and loads the saved versions. The editor is locked while those copies are saved.

Notes are Markdown files under `MODEX_HOME/notes/`, with their version history kept beside them in `notes/.modex/` ([Notes folder](notes.md)). Agents still work only through `modex_pages`, by page id and revision; an agent never edits the files directly. The first launch moves the pages of `MODEX_HOME/app/space.json` into the folder and leaves that file as it was, so an older Modex still opens it; pages an older build changes there come back under "Recovered from earlier Modex". Notes can still be exported as Markdown.

## Access boundary

The server binds only to loopback, rejects browser-origin requests, and uses an unguessable route for each thread. The route stays stable when a CLI resumes the thread, but access exists only during an active turn. Permissions are checked on every call. Turning chat or plan mode off during a running turn cannot grant write access to that turn. Stopping a turn revokes the route. Requests are bound to the turn that received them, including requests whose bodies arrive after a later turn begins.

Only note operations are exposed: no filesystem, shell, arbitrary URL or inference API. The MCP connection and its tool allowlist are passed to the coding CLI for that session. Knowledge base maintenance remains a separate setting and server.
