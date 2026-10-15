# Images and Plugins

Images and Plugins are local destinations in the full desktop app. The paired Store client
and iPhone do not expose these commands. Native plugin support follows the installed CLI's
capabilities; Modex does not rewrite undocumented CLI configuration.

## Plugins

Open Plugins to browse Installed, Discover, and Sources. Choose Claude Code or Codex and,
where the CLI supports it, a project and installation scope. The account shown is the shared
CLI identity: Modex account sign-in does not create a separate plugin home. A native change
also affects other applications using that installation.

Inspect the package and its full available skill text before installation. Sources accepts
HTTPS/GitHub marketplaces and a native folder picker for local marketplaces or plugin packages.
Local packages are copied into a bounded managed marketplace under the Modex home; originals
are preserved. Importing a source does not install or run its plugins. Use Discover to install.

Commands and scopes unsupported by the installed CLI are disabled. Authentication or explicit
command-source trust that requires the CLI stays in the CLI. Modex does not autoaccept it.
Configuration values use stdin, not command-line arguments. Cached discovery remains readable
offline, but generation requires a fresh installed/enabled/version check.

Plugin changes wait for active work to finish. Quitting stops and drains native plugin commands. Start a new chat after changing plugins;
existing resumed sessions are refused when their recorded plugin revision is stale.

## Images

Import PNG, JPEG, WebP, or GIF through the picker, drag/drop, or clipboard. Originals are copied
into private app storage. The library accepts up to 25 MiB and 40 megapixels per file, 20 per
batch. Chat/reference use retains the existing 5 MiB image limit. Unsupported or invalid files
report errors without discarding successful imports.

Search, filter by project or provenance, favorite, rename, export, and move images to Trash.
Deletion never changes the original source file. Permanent deletion is blocked while a Space
page, page history, draft, or active image job still references the image. Trashed assets remain
renderable by existing references. Thumbnails are regenerable; originals are retained.

Use in chat copies the image into the current draft through normal attachment ownership.
Chat attachment chips also offer Save to Images. Insert into Space saves a local asset link
with the page's revision check; exporting that page writes a sibling assets folder and portable
relative links. Existing remote links are not downloaded or migrated automatically.

## Generate and revise

From an installed user-scoped plugin's details, choose Use for Images and select its image
skill entrypoint. Mark reference/edit support only when the skill supports it. Bindings remain
unverified until a job actually registers a valid image. Rebind after changing plugin versions.

Open Generate, choose the skill, enter a prompt, and optionally add references. Importing,
dropping, or pasting while the composer is open also selects the imported images as references.
Edit with a prompt creates a new revision linked to the original; it never overwrites it.

Image prompts and references are saved locally. If a save is pending or fails, ordinary close
keeps the editor open until its current draft is acknowledged.

One image job runs at a time. Execution uses a fresh normal runner thread in a Modex-owned job
folder, with normal approval prompts and a transcript. The job-scoped registration tool only
accepts completed local images inside that job's output directory. A textual claim of success
without registered image bytes fails. Arbitrary remote URLs are not imported.

Cancel stops local execution; it cannot promise cancellation of provider work already accepted
remotely. Saved partial outputs remain. Retry creates a new attempt and can incur provider
usage again. Interrupted work is never automatically replayed after restart. Finish or cancel
image jobs before installing an app update.

## Verification boundaries

Demos and automated UI tests use an explicitly labelled offline plugin and synthetic image.
They exercise the real runner, approval handling, scoped registration, and asset persistence,
without provider calls. They do not establish live provider access or image quality. Live native
plugin/generation acceptance and human keyboard/VoiceOver acceptance require separate evidence.
