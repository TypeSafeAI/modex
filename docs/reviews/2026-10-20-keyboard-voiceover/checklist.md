# Keyboard and VoiceOver review of the conversation view, 2026-10-20

This is the human gate for [#281](https://github.com/TypeSafeAI/modex/issues/281) (CF-8): a person
drives the conversation view with the keyboard alone, then with VoiceOver, and records what they hear.
The automated accessibility test in `e2e/app.spec.ts` checks contrast, visible focus, hit areas of at
least 28 px, and reduced motion. It does not replace this review.

The expected results below come from two walkthrough probes that ran this exact scenario. They
recorded the focused element and the accessibility tree at each step. VoiceOver's wording differs
slightly from those names ("button", "collapsed", and so on), which is fine. The review checks what
a person actually hears and whether the order makes sense.

**Build:** use a build that includes #342 (keyboard focus after answering, folding, Stop and Jump to latest)
and #352 (the later Jump to latest race fix). On an
older build, steps A2, A3, A6 and A7 drop focus onto the page body. That is the defect #342 fixes.

## Setup (about 2 minutes)

The scenario uses the offline scripted engine and a disposable home and repository, so no CLI usage
is spent and `~/.modex` is never touched:

```sh
# from apps/desktop, in a worktree with #342 and #352 built (pnpm build)
node ../../docs/reviews/2026-10-20-keyboard-voiceover/seed.mjs /tmp/modex-voiceover   # prints the home
MODEX_HOME=/tmp/modex-voiceover/home npx electron .
```

1. Press Command-N, type `Add a contributing note`, and press Command-Return.
2. The scripted turn has these parts, in order:
   - a reasoning item;
   - "I'll take a look at the project first.";
   - three finished tool rows;
   - **approval 1**, "Allow add CONTRIBUTING.md?";
   - **approval 2**, "Allow shell: sleep 8; cat CONTRIBUTING.md?";
   - an 8-second command;
   - a reply with a `sh` code block.
3. Part A runs with VoiceOver off. Part B runs with VoiceOver on (Command-F5; VO = Control-Option).

## A. Keyboard only (no mouse or trackpad)

| # | Do | Expect | Pass? Notes |
| --- | --- | --- | --- |
| A1 | While approval 1 waits, press Shift-Tab from the message box | It reaches the card first: **Deny**, **YOLO**, **Always allow in thread**, **Always**, **Approve**. Then it goes up the transcript. Every stop has a visible focus ring. (Tab goes the long way round: the composer controls, the side panel, the rail and the sidebar, about 45 stops, before the transcript. Note whether that order is acceptable.) | |
| A2 | Press Return on **Approve** | Focus lands on the card's answer, "Approved". It doesn't jump to the top of the window. | |
| A3 | Approve card 2 the same way, then wait about 8 s | When the turn finishes, its work folds and focus moves to the **Worked for …** toggle (collapsed) | |
| A4 | Press Return on **Worked for …**, then Tab to the tool row **Done: $ git status --short \| head -5** and press Return | The work unfolds. The row expands to show the command, "[exit 0, …ms]" and an Arguments group. Return folds each one again. | |
| A5 | Tab to **Copy sh code** in the reply and press Return | The code is copied, and focus stays on the button | |
| A6 | With focus on a transcript item, scroll up (Page Up) | **Jump to latest** appears. Activating it returns to the bottom and puts focus in the message box. | |
| A7 | Type `Do it again` and send. Approve both cards. While `sleep 8` runs, Shift-Tab to **Stop** and press Return. | When the turn ends, focus is back in the message box. "Stopped." shows under the last approval. The offline engine finishes its current command first, so the row may read "done · 8 s". A real CLI is stopped mid-command (see the live smoke review). | |
| A8 | Switch to another thread in the sidebar and back | The thread keeps what you expanded and where you scrolled (CF-4) | |

## B. VoiceOver

| # | Do | Expect to hear (roughly) | Pass? Notes |
| --- | --- | --- | --- |
| B1 | VO-Right through a finished turn | "Add a contributing note", then the **Worked for … button, collapsed**. Then the reply ("Done. I added CONTRIBUTING.md with three steps. To read it yourself:"), then "sh", then the **Copy sh code** button, the code, "Nothing else in the tree changed.", and the **Save to Notes** button | |
| B2 | Unfold the work and VO-Right through it | The **Thought for 1s** button. Tool rows as buttons named by status and summary: "Done: list .", "Done: read package.json", "Done: $ git status --short \| head -5", "Done: edit CONTRIBUTING.md". The answered card reads "Allow add CONTRIBUTING.md? … Approved". | |
| B3 | While a card waits, VO-Right through it | The question, the patch or command, then the buttons **Approve**, **Always**, **Always allow in thread**, **YOLO** and **Deny**. After Approve, VoiceOver reads "Approved", because focus moves there. | |
| B4 | While the turn runs or waits, without moving the VoiceOver cursor | Note what, if anything, is announced on its own. The header reads "Working for 3s" or "Waiting for approval · 3s". The rail button reads "Active work: 1 active thread; 1 waiting for approval". The empty message box's hint is "Working… ⌘. to stop". The header is plain text, so a new approval may not be announced unless you move to it. Record what you hear. | |
| B5 | Activate **Copy sh code** | "Copied sh code" is announced (a status region) | |
| B6 | Stop a running turn (A7) | Record whether "Stopped." is announced on its own or only when you reach it. It's plain text, so expect only when you reach it. | |
| B7 | The composer | A text field named "Message", then the buttons **Plan, Auto and backend**, **Read only**, **Attach files**, **Scripted mock**, and **Send** (dimmed until there is text) | |

## Record

- **Reviewer:**
- **Date and build** (About Modex, or the worktree's `git rev-parse --short HEAD`):
- **macOS version and VoiceOver voice:**
- **Result:** pass, or the failing rows with what you heard instead.

Post the filled tables on #281. Each failing row becomes an issue linked from #281. Rows A1, B4 and B6
record behaviour that may be acceptable as it is. Val decides. The gate stays open until every row
passes or Val accepts a known limit.

## What the probes already checked

The probes ran on the scripted engine, on `main` with #342. Probe output is in this session's
evidence: the accessibility trees and the focus after each key.

- Before #342, Return on Approve left focus on `<body>`, and so did a keyboard Stop and Jump to
  latest. That is fixed and covered by `e2e/keyboard-answers.spec.ts`.
- With #342:
  - focus after Approve is the answer line;
  - focus after the turn finishes is the "Worked for 10s" toggle;
  - Return toggles `aria-expanded` on the turn and on the tool row;
  - Copy reports "Copied sh code";
  - Shift-Tab from the message box at a waiting card goes Deny, YOLO, Always allow in thread,
    Always, Approve, then the tool rows;
  - Page Up shows Jump to latest, and activating it puts focus in the message box.
