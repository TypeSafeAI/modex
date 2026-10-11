# Approval rules, parts 1 and 2

Reconstructed on 2026-10-03 from [PR #54](https://github.com/TypeSafeAI/modex/pull/54)
and the decisions recorded in `docs/status.md`. The earlier filename was referenced without
an accompanying document. This specification records the agreed behavior and the acceptance
criteria for the remaining work; it does not claim that they have shipped.

## Boundaries

Coding turns continue to run through the Claude and Codex CLIs. The optional Jev judge
answers typed questions about scrubbed action metadata; it never executes an action or sees
file contents. Approval rules only answer approval requests a backend actually makes. They
do not create extra approvals in full-access mode or widen a backend's sandbox.

New rules default to the current project, identified by the project's root path even for
worktree threads. All-project rules require an explicit scope choice. Rules requiring Jev
remain visible and are marked inactive when Jev is unavailable; exact-match rules still work.

## Rule evaluation (part 1)

A rule contains an ID, `when` description, `allow | ask | never` decision, enabled flag,
optional project root, and optional `<tool>: <glob>` match. Matching is case-sensitive;
`*` is the wildcard, and command patterns may omit a leading `$ `. Disabled and other-project
rules cannot decide an approval.

The gate checks deterministic matches first. It then asks Jev about up to 12 language-only
rules, prioritizing project rules and then newest rules, plus the destructive-action question.
A probability at or above the configured threshold applies; precedence is never, then ask,
then allow. A deterministic allow also receives the destructive check when Jev is available.
An allow becomes ask if destructive probability is at least 0.5 or the action requests a
sandbox/permission escalation. No rule can override these downgrades. This describes the rule
gate's result; the existing thread policy runs afterward. Always allow preserves explicit Ask
rules and downgrades; YOLO can answer them. Neither policy overrides Never. When no rule
applies, Always allow may answer a described, non-escalating action. See
[thread policy](../approval-rules.md#thread-policy-always-allow-and-yolo).

A missing judge, timeout, malformed response, or transport failure leaves only deterministic
matches in effect. Without an applicable match, the rule gate returns Ask; the thread policy
applies as described above. Aborting a pending decision
returns no. An automatic allow is always a single yes, never an always/session permission.

## Settings and Try it (part 2)

Settings exposes Approval rules: add, edit, enable/disable, delete, decision and project scope,
with an optional exact-match field. Save persists the edits; Cancel discards the draft.
Validation errors keep the dialog and its edits available. Rules for other projects must not
be lost when the current project's rules are edited. The UI uses the saved router's Jev
availability and distinguishes language rules that cannot currently run.

Try it accepts a sample action, backend/tool, and project context, and evaluates the current
rule draft through the same gate. It is a dry run: no coding turn, tool execution, transcript
item, or settings write. It may ask the configured Jev judge. The result reports allow, ask,
or never; deciding rule; exact match or Jev probability; elapsed time; and any downgrade or
judge failure. No match is an explicit ask result. Results are invalidated when their inputs
change. Preview remains available while the production gate is off and labels that state.

Use typed IPC for `approvals:rules:get`, `approvals:rules:set`, and `approvals:try`; main validates
inputs and resolves the project's root from its stored ID. Reuse the router's transport/key
resolution. Never introduce another credential path.

## Transcript receipts and denials

Automatic allow and never decisions produce compact, expandable receipt rows naming the
action, rule, decision source and elapsed time. They do not put the thread into waiting.
The expansion preserves the question/details and safety context. An ask remains an approval
card, with one reason line when a rule or downgrade caused it. Old approval items without
receipts render as before. Receipts persist with the transcript.

Claude receives `(rule: …)` in the denial message only when a never rule refused that exact
request. Human denials retain their existing message. Rule descriptions in the denial are
single-line and bounded. Codex retains its protocol's structured decline answer; receipts
explain the rule in Modex rather than adding unsupported RPC fields.

## Validation and release sequence

Required evidence: build, typecheck, unit tests and the full macOS Electron e2e suite.
`e2e/approvals.spec.ts` covers Settings persistence/cancel, default project scope, inactive
language rules without Jev, dry-run decisions/receipts and input changes, automatic allow and
never receipts, ask/downgrade cards, and isolation across projects. Fake Jev transport tests
cover destructive/escalation downgrade, timeout, invalid answers and abort; this is offline
coverage, not proof of live judge quality.

Historical part 2 release sequence: part 2 follows v0.0.6 and is excluded from its replacement
tag. The original instruction was to keep
`DEFAULT_APPROVAL_GATE.enabled` false until validation is complete
and the remote v0.0.5 tag exists. Reconcile the Settings integration with PR #51/current main
before landing. Do not create a release tag or merge unrelated work to satisfy this prerequisite.
The current enablement requirements follow below; the readiness record retains the tag check.

## Current acceptance decision (2026-10-11)

The [readiness record](../reviews/2026-10-11-approval-provider-readiness.md) reconciles this
specification with main `6c00c52` and PR #107. The remote `v0.0.5` tag exists; PR #51 and
the Settings integration are already on main. Those historical prerequisites no longer
explain the disabled gate. Current blockers are false-positive judgments, incomplete action
metadata, and missing human acceptance with real backend approval requests.

Before a separate enablement PR can change `DEFAULT_APPROVAL_GATE.enabled`:

1. Resolve the quoted-command and clipped-command false allows and verify an expanded,
   predeclared corpus with at least three live repeats per judge case. Require no unexpected
   allows, refusals, safety misses, or transport failures. Retain failed attempts as evidence;
   do not change expectations to fit observed results.
2. Prove native Claude/Codex escalation metadata reaches the gate, including command requests.
   An injected `escalation: true` preview only tests the gate after normalization.
3. Complete every human acceptance row in the readiness record with the current macOS build,
   both supported CLIs, fixture files, persisted receipts, and named reviewer/date evidence.
4. Pass build, typecheck, unit tests, and the full macOS Electron e2e suite on the candidate.
   Review exact-head CI and failures separately from live or human acceptance.

Known limits: project scope compares the originating project's root; it does not inspect
every target path or resolve symlinks. The backend sandbox owns file boundaries. Commands
are clipped to 500 characters and titles to 200 before judgment, without a truncation
downgrade. Exact-match globs inspect the full title but do not parse compound commands.
These limits must not be represented as semantic or filesystem enforcement.
