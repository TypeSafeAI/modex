# Update preparation and draft recovery

Modex prepares a verified update before asking you to restart, and preserves saved drafts
when restart preparation fails. v0.0.12 is the first published build with automatic
installation; its signed native upgrade, download-failure and interruption scenarios passed in
the release workflow. Builds before v0.0.12 install it manually once.

## Download and restart

Supported packaged Macs offer **Download update**, progress and cancellation, then
**Restart to update** after verification. Development, demo, automated-test, and Host Preview
builds keep automatic installation disabled. Windows and Linux show no update banner; install
a newer release by hand.
Missing archive integrity metadata also leaves manual installation available.

The downloaded ZIP must match its size and digest. The running app and candidate must pass
publisher, bundle identity, version, architecture, and notarization checks. A matching hash
alone does not authenticate the publisher. Release requests contain no prompts, files,
account credentials, or draft text.

If download or verification fails, the banner keeps its generic message, offers Download
update again, and adds the failure's own reason as one short line (for example "Update
archive checksum mismatch."). The full error is written to the main-process log. A
cancelled download shows no reason.

Restart waits for accepted commands, coding turns, approvals, discovery, follow-ups,
model learning, terminals, and retirement to finish. It holds new work while saving composer
and Pages drafts. Open Settings or Companion dialogs, pending attachment operations,
pending sends, unfinished page actions, and failed saves refuse preparation.

Save and close Browser and Canvas tabs before restarting. Save and stop or disconnect
Knowledge. Embedded pages have no draft-saving bridge; closing them automatically would
not prove their work was saved. Pages remain registered for saving when another surface
is selected.

## Local drafts and pending sends

On macOS and Linux, drafts are stored privately under `~/.modex` or your selected
`MODEX_HOME`. Windows continues using the existing composer path; native durable-draft
acceptance on Windows is still open. Browser and Store clients cannot write the desktop
host's draft files.

`app/update-recovery.json` uses schema 2. It stores raw text and attachment references per
thread and per project, plus the selected thread and shared new-chat configuration. The
configuration includes Local/Worktree, provider, mode, model, plan, Auto, and effort. Switching
owners preserves independent drafts; clearing a draft persists the empty value. Whitespace
and other raw text are retained unchanged. Streamer Mode affects display only.

Autosaves are coalesced. Closing saves any final unsaved snapshot synchronously. A failed
save keeps the text visible, offers Retry, and vetoes closing. Each renderer document has
its own main-owned authority and ordered saves, so stale replies cannot overwrite newer
work. The recovery file allows at most 1,000 combined thread/project rows, 1 MiB of text per
draft, and 2 MiB in total. Exceeding a limit refuses the save instead of truncating text.

Sending seals the original text and files durably before clearing the composer. New typing
stays separate from that original. Ownership-transfer journals and retained attachment
files protect interrupted creation and sending; restarting never silently resends an
original or starts inference. An explicit retry uses its original identity. Removing a chip
or retiring a draft revokes its editing ownership; recovery can retain earlier bytes instead
of deleting them immediately. Unknown,
corrupt, or uncertain recovery evidence is preserved for repair.

Deleting a thread or project, including automatic retirement, first flushes the current
draft and checks its pending originals. Nonempty affected drafts or pending originals
refuse removal. Empty affected rows can be removed while unrelated text, files, and shared
configuration stay intact. An unacknowledged durable removal keeps the workspace in
read-only recovery rather than granting fresh editing authority.

## Failure recovery

Before native update checking begins, main writes an attempt receipt binding the source
and target versions and verified archive digest to the saved draft revision. Navigation,
stale acknowledgments, or failed editor saves cannot authorize installation. Only the
trusted running app's exact target version confirms installation after relaunch.

A refusal before service shutdown releases the holds. Partial shutdown keeps them and
offers Quit. A replacement renderer opens the saved drafts read-only, even if no native
receipt was written. Quit then reopening in a fresh process can restore editing when
native update admission never occurred.

An interrupted native handoff remains uncertain across relaunch. Saved text is available
read-only for copying, new local and remote work is refused, and external services do not
start. Quit and reopen may let the native installation finish. If the old version returns,
use the target release link for manual installation. No recovery action clears an uncertain
attempt or retries native installation. Unreadable files remain untouched, with an action
to open the recovery folder.

## Verification boundary

On 2026-10-12, the local monorepo build and workspace typechecks passed. The full unit suite
passed 1,362 tests with 15 skips, and the integrated E2E run passed all 270 desktop and seven
site cases. Coverage includes independent raw drafts across full relaunch, save-failure
close veto and retry, pending original messages, attachment capacity and late results,
owner removal, automatic retirement, terminal lifecycle, partial-shutdown reload, and
actual recovery Quit. See the [local acceptance report](reviews/2026-10-12-updater-local-acceptance.md).

Controller UI tests simulate download, staging, and publisher verification and assert zero
native updater calls. The signed hosted native matrix (upgrade, failed download, interrupted
download) passed in the v0.0.12 and v0.1.0 release runs, and on 2026-10-18 an installed v0.0.12
updated itself to v0.1.0. The native harness
verifies exact schema-2 project ownership and retains real signing checks and Squirrel
events, but its local tests do not prove an installed upgrade. See the
[native updater release gate](release-signing.md#native-updater-release-gate) and
[Windows/Linux evidence](native-platforms.md) for acceptance requirements and limits.
