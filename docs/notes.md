# Notes folder

Space notes live in a folder of Markdown files, `MODEX_HOME/notes/`, laid out
**Workspace › Project › Folder › notes and files**. They moved there from one
`MODEX_HOME/app/space.json` in v0.1.0 (see [Migration](#migration)). This page
describes the format `NotesStore` (`apps/desktop/src/main/engine/notes-store.ts`) reads and
writes. Space and the Pages tools (`modex_pages`) use it.

## Layout

```
notes/
  .modex/                     Modex's own records (hidden from Finder's listing and Open Knowledge)
    index.json                where each note file was last seen, and its hash as Modex confirmed it
    history/<id>.json         every version of one page, oldest first
    comments/<id>.json        that page's comments
    tasks/<id>.json           the task record a Save to Notes wrote with that page (docs/task-context.md)
    trash/<batch>/…           trashed note files, by original path; <batch>.json lists them
    migration.json            receipt: what was migrated from space.json, and when
  Personal/                   a workspace        (.modex-workspace.json)
    Notes/                    a project          (.modex-project.json)
      Weekly update.md        a note
      Plan/                   a folder: a page with child pages
        Plan.md               its folder note, named like the folder
        Child.md
```

- **A depth sets the role.** Folders at the top are workspaces, inside them projects, and any
  folder deeper is a folder of notes. Personal › Notes is the default workspace and project.
- **A page with children is a folder** that holds its own folder note. Adding a child to a plain
  note turns it into one. A note and a folder never share a name in one place.
- **Every note Modex writes carries its id** in frontmatter, so a move, a rename or a crash never
  loses which page a file is:

  ```markdown
  ---
  modex_id: 3f2c9a1e-…
  title: "A/B plan"
  ---
  The page's Markdown, exactly as written.
  ```

  `title` appears only when the file name cannot carry the title (characters a file name
  refuses, a suffix such as `Plan 2`, or an empty title). Other keys, from Open Knowledge or
  anything else, are kept as they are.
- **Names** are Unicode-normalized, compared without case, never hidden (no leading dot), free of
  path separators and characters Windows refuses, at most 200 bytes, and never `index` (Open
  Knowledge reserves `index.md`). Typing a title does not rename the file; Space renames it when
  the title loses focus.

## The tree

`notes:tree` lists the folder as workspaces, projects, folders, notes and files. A note node is
its page. A folder with a folder note is shown once, as the folder, named by its page.

- **Ids hold across renames and moves.** Workspaces and projects keep theirs in their marker
  files. Other folders and plain files keep theirs in `.modex/index.json`, found again by path,
  or by inode after a move in Finder.
- **A typed folder name** that a folder cannot carry (a colon, say) is kept in the index. It is
  shown while the folder keeps the name made from it; a rename in Finder wins.
- **Placement rules:** workspaces sit at the top, projects in a workspace, and folders, notes and
  files in a project or folder. Moving a folder into itself is refused, and so is deleting a
  container that still holds anything.
- **A page that moves** gets a version ("Moved page" or "Moved folder") before its file moves, so
  the next read does not mistake the move for one made outside Modex. Notes inside a moved
  folder keep their revisions.

## Files

Any file in a project or folder that is not a page shows in the tree as a file.

- **Importing** (a row's **Import files…**, or files dropped from Finder onto a project or folder)
  copies regular files, never links or folders: up to 50 at a time and 100 MB each. A copy never
  replaces anything; a file whose name is taken gets a number (`diagram 2.png`), and a file name
  never matches a note or folder already there.
- **Previews:** images (PNG, JPEG, GIF, WebP, SVG, AVIF up to 25 MB) show over
  `modex-notes://file/<id>`, which serves only image files of the notes folder, by id. Text files
  up to 1 MB show as text. Anything else opens in its own app or in Finder.
- **Images in a page** can be named by a path relative to the page's file (`![](diagram.png)`,
  `![](../assets/a.png)`), as Open Knowledge writes them. They load over
  `modex-notes://page/<page id>/<path>` only when the file is an image inside the page's own
  project, after following links, and outside dot folders. Anything else shows no image.
- **Moving:** drag a row onto a folder, project or workspace where it may go; Move to… in a row's
  menu does the same.

## Watching the folder

Space reads the tree and the pages every 1.5 seconds. The app watches the folder (`fs.watch`,
recursive), and a read reuses the last look until an event arrives, a deletion awaits its second
look, or 10 seconds pass. Every change Modex makes looks afresh. With 500 notes a read went from
about 10 ms to 0.1 ms. Without a watcher (tests, or a folder that cannot be watched), every read
looks again.

## Projects

Each Modex project has a notes project, made in the default workspace when the project is added
(or, for projects added earlier, when notes first open). Its marker records the Modex project and
its code folder. Removing the project from Modex keeps the notes and unlinks them; adding the
same folder again links them back. Moving a project's notes to another workspace regroups it in
the chat sidebar.
A project's menu in the chat sidebar also has **Move to new workspace…**: name it, press Enter,
and Modex makes the workspace and moves the project's notes into it in one step
(`project:new-workspace`). It works while there is only the default workspace. Escape or leaving
the field makes nothing, and if the move fails, the new workspace is removed again.

## History and revisions

The newest version in a page's history file is the page: its revision, favorite, place and trash
state. Revision checks, the 30-second typing checkpoints, trash and restore, revert and comments
behave exactly as they did with `space.json`.

Writes go history first, then the note file, then the index. Reading reconciles what a crash left
between them: a history that is ahead is written to the file, and a trash or restore that stopped
partway is finished.

## Edits outside Modex

The folder is yours: Finder, an editor or Open Knowledge can change it.

- **An edit** to a note's title or text becomes a version by "Outside Modex". Edits within 30
  seconds share one version, as typing does. A Space window holding the old revision gets the
  usual "changed in another window" conflict.
- **A move or rename** keeps the page; a page moved into another folder takes that folder's note
  as its parent.
- **A new Markdown file** becomes a page ("Found in notes folder"). Modex never writes into a file
  just because it listed it.
- **A deleted file** goes to Trash after two looks at least a second apart, so a save that renames
  or a `git checkout` is not a deletion. Restoring it writes it back from its history.
- **A copy** made in Finder gets its own id the next time Modex saves it; the original keeps its.
- **A copied workspace or project folder** carries its original's marker. The folder that comes
  first in name order (the original, since Finder names copies "… copy" or "… 2") keeps the id and
  any Modex project link; the copy gets an id of its own and is linked to none.

Notes larger than 2 MB, files that are not UTF-8, links, and anything inside a dot folder (`.git`,
`.ok`, `.modex`) are not pages.

## Migration

On first use, the pages of `app/space.json` move into Personal › Notes, with their ids,
revisions, histories and comments; trashed pages go to the trash. The folder is built beside
`notes/` and appears with one rename, so a crash leaves either nothing or everything.
`space.json` is never written again, and a copy is kept as `space.json.pre-notes-<hash>.bak`.

An older Modex still reads `space.json`. If it changes pages there and the newer Modex opens
again, those pages come back as new notes under **Recovered from earlier Modex** rather than
over anything newer.
