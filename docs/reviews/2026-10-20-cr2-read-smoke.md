# Code Review read service: authenticated smoke test, 2026-10-20

Part of [#321](https://github.com/TypeSafeAI/modex/issues/321) (CR-2) under tracker
[#319](https://github.com/TypeSafeAI/modex/issues/319). This is AC5: read-only evidence against a
repository the user authorized, kept separate from the fixture tests. Val authorized
TypeSafeAI/modex for it on 2026-10-20.

The probe below runs the compiled read service with the real `gh` transport, through the person's own
`gh` login, GET only. It prints the account and host, the PR, the head SHA, each read's state and
coverage, and request counts. It never prints a token, a header value or a response body. To run it:

```sh
cd apps/desktop && pnpm run build:main
mkdir -p .probes && cp ../../docs/reviews/2026-10-20-cr2-read-smoke.mjs .probes/cr2-live-smoke.mjs
node .probes/cr2-live-smoke.mjs 334      # a PR number in TypeSafeAI/modex
```

`.probes/` is git-ignored. The script itself is committed next to this page as
[`2026-10-20-cr2-read-smoke.mjs`](2026-10-20-cr2-read-smoke.mjs).

## Results

Run on `cr2-read-service` after the review fixes, at 2026-10-20T20:32Z, with gh 2.98.0 and API
version 2022-11-28. Both runs used account `BunsDev` (id 68980965) on `github.com`, and repository
`TypeSafeAI/modex`, stable id `1386876170`.

| Read | #334 (head `5106c0d8e56d4ea3f72d37c1b1afe45f9d30a57e`, merged) | #330 (head `6f3a6c98c7cdaaacee25570c12a0c303ff4c8b0d`, merged) |
| --- | --- | --- |
| `connection` | ready: connected | ready: connected |
| `inbox` (`repo:TypeSafeAI/modex`) | ready; both groups complete | ready; both groups complete |
| `resolve` (the PR's link) | ready | ready |
| `overview`, then again | ready, then ready from a `304` | ready, then ready from a `304` |
| `activity` | ready: 33 items, complete | ready: 20 items, complete, including a bot's review |
| `checks` | ready: 13 of 13 | ready: 13 of 13 |
| `files` | ready: 5 of 5 | ready: 9 of 9 |
| `context` (lines 1–3) | ready: `docs/status.md`, 248 lines | ready: `apps/desktop/src/main/engine/desktop-client.ts`, 320 lines |
| `stack` | unavailable: `failed`, waits for #323 | the same |
| A key for another account | unavailable: `signed-out`, no request | the same |
| An unknown repository id | unavailable: `not-found`, no request | the same |

Each run made 17 requests: 15 core and 2 search. 7 of them were `304`s, which GitHub doesn't charge.
One was `gh api user`. The unchanged `hosts.yml` fingerprint confirmed the account after every other
read without asking gh again.

## What the live runs found

The first runs, before #349 opened, read `activity` as `partial`. Two of GitHub's timeline shapes didn't
match the mapper; both were fixed in `197276e`, with failing tests first:

- A `cross-referenced` event has no `id` or `node_id` of its own. Main names it from the issue or PR
  that mentions this one: `xref-<source issue id>-<seconds>`.
- The timeline spells review states in lower case (`commented`), where the reviews API uses upper case.

After the fixes, the timelines of #295, #316, #330 and #334 map with nothing dropped.

Also seen live, and written into the design page's
[Read service](../design/code-review.md#read-service-cr-2) section:

- Search results carry `repository_url` but no `repository` object, though the schema lists one.
- A `304` exits 1 but prints its status line, and GitHub doesn't charge it.
- Under the raw media type, a file answers as `application/vnd.github.raw` and a directory as an
  `application/json` listing.

## Not covered

- Other accounts and other repositories.
- A real `gh auth switch` during a run; the fixture tests cover switches.
- The renderer: CR-3 (#322) records its own authenticated navigation smoke test once it reads through
  this service.
