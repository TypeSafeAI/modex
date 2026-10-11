# Codex additional-permission recovery

Recovered from the dirty `permission-response` worktree into `recover-permissions`,
based on main `6c00c52`. The original source worktree is preserved.

The installed `codex-cli 0.162.1` generated its protocol with:

```sh
codex app-server generate-json-schema --experimental --out apps/desktop/.probes/codex-0.162.1-schema
```

`PermissionsRequestApprovalResponse` requires `permissions`; `scope` accepts `turn`
or `session`. Modex now returns only the inspected requested profile on **Allow**, with
`scope: "turn"`. Deny or an unexpected **Always** answer returns an empty profile.
Unknown grants and malformed profiles are rejected without displaying an Allow button.
The detail is no longer truncated, and the returned profile is cloned before waiting
for the human decision. Known network and filesystem forms, nullable fields, path,
glob and special-path entries are supported. Unknown special-path kinds are unsupported.

The two recovered regression tests failed against main's `{ decision: "accept" }`
response before the production patch. Coverage checks exact JSON-RPC responses,
full detail for a long profile, denials, unexpected answers, nullable/empty profiles,
and malformed/unsupported values. These use a fake transport; they are not live model
acceptance. Schema generation uses the installed binary but does not exercise an
actual model-generated approval or subsequent sandbox execution.

Validation on 2026-10-11:

- `npm run build`: passed for core, desktop, site and Store desktop.
- `npm test`: passed on the complete rerun: core 15, desktop 433 plus one browser
  harness test, site 10 and Store desktop 9 (468 passed total). The existing optional
  live OpenKnowledge test was skipped. The initial run and one isolated retry failed
  the existing process-disposal test after its two-second wait. An instrumented probe
  confirmed group termination, and the full rerun passed unchanged. No lifecycle fix
  or timing guarantee is claimed.
- Four captured backend responses (allow, deny, unexpected answer, malformed profile)
  passed JSON Schema validation against the installed binary's generated response schema.
- Independent code review found no critical or important issues; nested profile cloning
  and three focused backend tests were independently checked.
- `git diff --check`: passed.

Hosted protected checks remain required before merge. No renderer code changed.
