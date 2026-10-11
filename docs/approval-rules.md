# Approval rules

Approval rules answer requests from a coding CLI before Modex asks you. They do not execute
tools themselves, create approval requests the CLI did not make, or widen a sandbox.

The gate remains **off** while this integration is reviewed. Settings can save rules and
**Try it** can preview their decisions during this period. Rules do not answer live approvals;
the existing thread policy still applies (Ask each time, Always allow, or YOLO).
This editor follows v0.0.6 and is not included in its replacement release tag.
See the [specification](specs/2026-10-01-modex-jev-approval-rules-spec.md).

## Add a rule

Open Settings → Approval rules, then Add rule. Complete “When the agent wants to …”, choose
Allow once, Ask me, or Never allow, and save. Cancel discards edits. A failed save leaves the
draft available to correct or retry. Existing rules can be edited, disabled, or deleted.

New rules belong to the current project, including its worktree threads. Select All projects
explicitly to share a rule. Rules belonging to other projects remain visible and keep their
scope when you edit this project's rules.

Language rules use the same saved Jev transport and credentials as Auto routing. Without
Jev, they stay visible with **Inactive without Jev**. An optional exact match works without
Jev: `Bash: npm test` for Claude, or `command: npm test` for Codex. Tool names and patterns
are case-sensitive; `*` matches any text. A leading `$ ` in the command title may be omitted.
Exact matches are mechanical patterns, so keep allow patterns narrow. For example,
`Bash: npm test*` also matches `npm test; rm -rf ./src`. The glob does not parse shell
operations, and without Jev there is no destructive-action judgment.

## Try a draft

Choose a project, backend, tool and sample action under Try it. The preview evaluates the
unsaved rules above using the same gate as real approval requests. It never starts a coding
turn, executes the sample, saves settings, or adds transcript items. It may send scrubbed
sample metadata to the saved Jev judge. Save changes to the Jev configuration before trying
them here.

The result shows the decision, deciding rule, exact match or Jev probability, elapsed time,
and safety downgrade or judge failure. Changing the sample or rules clears the result. A
preview is an example for that action and configuration, not a guarantee about future requests.

## Decisions and receipts

Matching rules combine as **Never > Ask > Allow**. Jev considers at most 12 language rules,
prioritizing project rules and then newer rules. The default match threshold is 0.8.

An allow becomes ask when the action requests additional sandbox permissions, or Jev rates
the chance it is destructive at 0.5 or higher. An allow is always one approval, never a
session-wide “Always”. If Jev is missing, times out, or returns invalid answers, only exact
matches can decide; otherwise Modex asks you. Stopping a pending judgment refuses it.

Automatic allows and refusals leave compact, expandable transcript receipts. Expand one to
see the request, rule, source, timing and safety context. An ask keeps the normal approval
card and explains the rule or downgrade that sent it to you. Old cards still render normally.

Claude receives the rule description in a rule-driven refusal, bounded to one line. Human
denials keep their existing message. Codex receives its normal structured decline; Modex's
receipt holds the explanation.

## Thread policy: Always allow and YOLO

Each thread also has a standing answer to approvals, separate from the rules above. Set it from
the access menu in the composer, the **Always allow in thread** and **YOLO** buttons on an
approval card, or the Approvals menu on the iPhone.

- **Ask each time** (default): every request the CLI makes gets a card.
- **Always allow**: approves what the CLI asks about in this thread. It still asks before
  extra sandbox access, when the request cannot be described (no structured action), and when
  your rules sent it to you on purpose: an **Ask** rule, or a downgrade because the action looked
  destructive.
- **YOLO**: approves everything, extra sandbox access included. Switching to YOLO also answers
  whatever is already waiting. The phone and the Mac both confirm before turning it on.

The policy applies only where the rules left the decision to a person: a **Never** rule still
refuses in YOLO. YOLO overrides **Ask** rules and downgrades; Always allow does not. It lives on the thread, so it does not carry to new threads or projects.
Approvals it answers appear as compact receipts ("Always allow in this thread"). This is not the
CLI's own "Always" for one command, which remains on the card.

## Data sent to Jev

The gate sends tool/title, scrubbed command text, paths, project name, branch when available,
and mode. It does not send file contents, patches, edit strings, or coding-session messages.
The preview accepts only sample metadata. Credential lookup is shared with
[Auto routing](auto-routing.md); there is no second key store or coding API mode.

## Live preview evidence

On 2026-10-05, the built preview and shared router completed three judgments using the
saved Modex credential and Jev CLI 0.2.1: allow a test command, refuse a deletion, and
downgrade a requested escalation to ask. The production gate stayed off and no action
was executed. These examples verify the configured transport and preview integration;
they do not establish general judge correctness or human approval acceptance. See the
[acceptance record](reviews/2026-10-05-approval-preview-acceptance.md).

The [2026-10-11 readiness review](reviews/2026-10-11-approval-provider-readiness.md)
supersedes those three examples as the enablement decision: **not ready**. A 62-check
evaluation found six false allows across two cases (three repeats each): mentioning a
test command inside `printf`, and a destructive suffix hidden by command truncation.
The production default and saved gate remain off. The review includes reproducible probes,
specification reconciliation, and the human acceptance procedure still required to enable it.
