# Conversation evidence

What a turn leaves behind that you can check: where a reply says its information came from, the
commands that actually ran and how they ended, and the patches the turn applied. This is the first
part of [#278](https://github.com/TypeSafeAI/modex/issues/278) (CF-5 of tracker
[#273](https://github.com/TypeSafeAI/modex/issues/273)). It builds on the
[conversation-event contract](conversation-events.md).

Every label says exactly as much as the CLI reported, and no more. A citation shows where the model
says something came from; it does not prove the statement. Nothing in this view opens, fetches,
imports or runs anything by being shown.

## What each CLI provides

Observed on 2026-10-18:

- **Claude Code 2.1.302** (`claude -p`, Haiku 5.5, a WebSearch turn). The tool returns plain text with
  a `Links: [...]` list. The reply's text block carries no `citations` field, only Markdown links the
  model wrote. Through `claude -p` there are no native citation annotations.
- **codex-cli 0.163.0** (its generated app-server protocol). The only structured citation is
  `agentMessage.memoryCitation`: entries with a `path`, `lineStart`, `lineEnd` and `note`, plus the
  `threadIds` they came from. Web-search items carry opaque `results` and an `action`. Messages carry
  no offset-based URL annotations.

## In the transcript

- **Links in the reply.** A trailing "Sources:" list the model wrote becomes cards labelled "Links in
  the reply", marked `data-provenance="reply-text"`, with a note that Modex has not checked them. They
  are not called citations or sources.
- **Codex memory citations.** These are native evidence: `memoryEvidence` (in `shared/evidence.ts`)
  turns them into `evidence` on the assistant item, shown as "From Codex memory" with the file, line
  range and note. Entries that are not well formed are dropped: a missing path, a negative or
  fractional line, or an end before the start.
- **Reading a memory citation.** Each citation has **Show lines** and **Copy**. Both ask main
  (`evidence:memory`, `main/engine/memory-citations.ts`) for the cited lines.
  - **Where main reads.** Only inside Codex's memories folder: `$CODEX_HOME/memories`, else
    `~/.codex/memories`.
  - **What it refuses.** An absolute path, any `..`, a symlink that resolves outside the folder,
    a directory, a file over 8 MiB, and a range that starts past the end of the file.
  - **What it returns.** Only the cited lines, 1-based and inclusive, cut to 64 KiB. It says
    when the range ran past the file's end, and when the excerpt was cut.
  - **Nothing else happens.** No file is opened in another app, and nothing is executed or
    fetched.
  - **Mac only.** The command is local-only: a paired desktop never reads this Mac's memory
    files, and says so.
  - **Streamer Mode.** It masks the shown lines; Copy puts the lines themselves on the
    clipboard.
  - **Evidence.** Local codex-cli 0.163.0 sessions cite paths relative to the memories folder
    (such as `MEMORY.md`). A one-line citation's note matched its line counted from 1 and not
    from 0, so lines are 1-based.
- **The command that ran.** A tool item's `exec` holds the command exactly as the CLI reported it,
  apart from the shortened title, with its `cwd` when the CLI reported one. Codex reports both. Claude
  Code's Bash keeps its own working directory between calls, so a Claude command shows no directory.
- **How it ended.** `exitCode` is the code the CLI reported ("Exit code 2"); `null` means the CLI said
  there is none, as for a declined command ("No exit code"). When the field is absent, the CLI did not
  report one: Claude never does ("Exit code not reported"). The outcome (succeeded, failed, denied,
  stopped, unknown) stays separate. No output is split into stdout and stderr, and no test counts are
  read out of it.
- **Bounded output.** A tool item keeps the last 256 KiB of its output (`OUTPUT_PREVIEW_BYTES`), cut on
  a UTF-8 character boundary, with `outputBytes` (the total seen) and `outputTruncated`. The view
  says "Showing the last 256 KB of 3.0 MB." Codex output is bounded as it streams, so no update
  carries a whole log, and the runner bounds every tool's output before it is saved or sent.
- **The full log.** A tool whose output passed the preview has **Show full log** under its
  truncation notice. It asks main (`evidence:tool-log`) for the kept output, a page at a time.
  - **What main keeps.** Codex streams every chunk (`item/commandExecution/outputDelta`). Its backend
    hands each raw chunk to `TurnSink.output`, which only main sees: it is never journaled or sent
    to the window. `main/engine/tool-logs.ts` holds a tool's output in memory until it passes the
    preview, then keeps it **from the first byte**, up to 10 MiB, in
    `app/tool-logs/<thread>/<item, hex>.log`, and records the total when the tool finishes. Output
    that fits in the preview is never written. The logs go when their thread is deleted.
  - **Reading it.** 256 KiB pages that end on a character boundary, with Earlier, Later, Copy page
    and Hide. The status says "Kept all 3.1 MB", "Kept the first 10.0 MB of 12.0 MB", or that the
    tool never finished, so the rest is unknown. Nothing is read until asked, and reading runs
    nothing. Streamer Mode masks the page; Copy puts the page itself on the clipboard.
  - **Ids never become paths.** Thread ids are checked, item ids are hex-encoded, and main only reads
    a log for a tool item of that thread.
  - **Claude.** Claude Code 2.1.302 hands Claude at most `bashOutputMaxChars` (default 30,000
    characters, clamped to 4,000–128,000) of a Bash result and keeps the rest in its own file, with
    the path in the result. A Claude result never outgrows the preview, so there is no Claude log to
    keep. Modex does not read the path Claude Code names.
- **Patches.** A patch tool (`apply_patch`, `Edit`, `MultiEdit`, `Write`, `NotebookEdit`) is labelled
  "The patch as this turn applied it. The working tree may have changed since; Changes shows it now."
- **Comparing a patch with the working tree.** A patch the CLI reported as applied has **Compare
  with working tree**, then **Check again**. It asks main (`evidence:patch`,
  `main/engine/patch-state.ts`), which takes the patch from the thread's own record, not from the
  window.
  - **What each file says.** One verdict per file, with the time of the check:
    - *As this turn left it*: the file is exactly what a `Write` or a Codex add wrote, or is still
      absent after a Codex delete.
    - *Still has this turn's edit*: the text an `Edit` or `MultiEdit` put in is still there, or
      each Codex hunk's new lines are still there, in order. The rest of the file is not known.
      - **Text an edit only removed** must still be gone. Claude Code's Edit needs `old_string`
        to be unique unless `replace_all` is set, so after a removal it is not in the file.
      - A removal whose text another edit in the same MultiEdit puts back proves nothing, so it
        is not checked.
      - **A notebook cell.** Claude Code 2.1.302's `NotebookEdit` carries `notebook_path`,
        `cell_id`, `new_source` and `edit_mode` (`replace`, `insert` or `delete`).
        - A replaced cell must have that id and source.
        - An inserted cell must have that source. An inserted cell gets a new id, so the id isn't
          checked.
        - A deleted cell's id must be gone.
        - Sources are joined from Jupyter's line list, and a final newline is ignored.
    - *Changed since this turn* and *Deleted since this turn*. A moved file is checked at its new
      path, and it reads as changed if a file is back at the old path.
    - *Not compared*, with the reason.
  - **When it says Not compared.** A file outside the thread's folder, or a link that leads out of
    it. A directory, or a file over 8 MiB. An edit with no text on either side. A notebook delete
    that names no cell, or a file that is not a readable notebook. A Codex patch saved before
    per-file records were kept.
  - **What it reads.** Only the files the patch names, inside the thread's folder (realpath, no
    link at the last step). Only verdicts reach the window, never file contents.
  - **Nothing else happens.** Opening the row reads nothing. Comparing writes nothing and runs
    nothing. A patch that was denied, failed, stopped or has no known outcome is not compared.
  - **Paired desktops.** A paired desktop can compare too. It learns less than `files:read`
    already gives it.
  - **The Codex record.** codex-cli 0.163.0 sends each file of a `fileChange` with an absolute
    `path`, and an update's diff as hunks only (`@@ -a,b +c,d @@`, no file headers); an add
    carries the whole file. Observed in local Codex sessions and in Modex's own thread records.
    Modex keeps the diffs joined in `args.patch`, as before. Beside it, `args.files` keeps each
    file's `path`, `kind`, `movePath` and `lines`: how many lines of `patch` are that file's
    diff. So no diff is stored twice.

## Owned artifacts

Images, Notes and Knowledge changes, and attachments already reach the transcript through their own
owners. Image registration uses Images; note and knowledge receipts open through `pages` and
`knowledge:open`; attachments go through `attachments:open`. Each checks access in main. This work
adds no new artifact store. Its only new reads are a memory citation's lines and a patch's files, above.

**A missing attachment.** Opening an attachment whose file was deleted is refused ("no longer on
disk") and nothing is revealed (`test/attachment-commands.test.ts`). Existing tests cover the rest:
- symlinked files and folders, `..` and non-canonical paths are refused;
- one thread's files can't be taken over by another thread;
- attachment URLs refuse anything else;
- images refuse symlink reads, spoofed formats and traversal.

## Not done yet

- Native web-search results as structured evidence. Codex's `results` are opaque JSON, and Claude's
  arrive as tool text.
