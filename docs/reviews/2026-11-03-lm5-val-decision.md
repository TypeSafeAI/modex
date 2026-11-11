# Local models: the decision for Val, 2026-11-03

Restates the [LM-5 admission brief](https://github.com/TypeSafeAI/modex/issues/380#issuecomment-6558687340) against `main` at `68fe543` and the branches below. Nothing here changes `main`: it still constructs no `LocalExecution`, so a built app refuses every local selection and persisted target. Since the brief was posted, `main` gained only unrelated work; no file under `engine/local-models/` changed.

## The one decision

**Recommended: yes in principle, with the merge held.** Land the two repair branches now. Install one local coding model. Merge admission only after AC1 passes live on that model, together with the first LM-4 UI.

## What is ready

| Branch | What it holds | State | To land it |
| --- | --- | --- | --- |
| `lm5-fixtures-rebased` | #475 on current `main`, with the review findings fixed | Head `7a38090`. Full suite green before the last rebase over #488, 2,122 passed, 0 failed; independent review found no blockers | Update #475: `git push --force-with-lease=lm5-fixtures:7cc5713 origin lm5-fixtures-rebased:lm5-fixtures`. That branch belongs to another session, so this is Val's or its owner's |
| `lm-ready` | `config.toml` byte check, token regression, streaming redaction fix, LM-7 map, LM-4 brief, this record | Full suite green before the last rebase over #488; see [its review record](2026-11-03-lm-global-config-and-token-records.md) | Open a PR; independent of #475 |
| `lm5-admission` | Both of the above, plus the one `LocalExecution` option and the inverted wiring test | Full suite green at `1276a29` on current `main`, 2,128 passed, 0 failed, which also runs the other two branches' tests; the full E2E suite was not run, and the IPC E2E passed before the last rebase | **Your decision.** Don't merge before the above |

Rollback is removing the one option. Tested: the wiring test then fails, and the existing test for a runner with no local execution still passes, showing refusal.

## What main enforces

Unchanged from the brief. A target comes only from this Mac's window (with #475). `LocalExecution.validate` checks the exact revision and readable token, an IP-literal loopback address, the context window and known cloud-routed or non-generative models, at selection and every send. The child gets a private home, an environment allowlist and a token its shell can't see. Its effective configuration is read and admitted before any thread opens. Auto, Jev, the credit fallback, naming, follow-ups and routines never reach a local thread.

**New since the brief:** a token split across streamed chunks was being rebuilt in renderer events. A loopback server receives the token, so it could do this. That's fixed on `lm-ready`.

**Correction to the brief.** It said compaction goes to the configured server "and nowhere else", and that each failure had "no retry, no model switch". The fixture server can only see its own requests, so these describe what it observed. No fixture fails a compaction request, and the 0.166.0 binary contains strings suggesting a compaction fallback path (`compact_model_fallback`); that lead is unverified. Only a network-denied run can close this.

## Limits that stay

- **Redirects.** Codex 0.166.0 follows a 307 from the loopback server with the full request body, prompt included, without the token. No Codex setting stops it.
- **Forwarding.** A loopback server may send requests anywhere. Loopback is a configured destination, not verified locality.
- **Loaded size.** Recorded as `unknown`.
- **Truncated tool output.** If the 256 KiB display cut falls inside a token, the rest of that token stays visible.

## Five questions

| # | Question | Recommendation | Why, and what follows |
| --- | --- | --- | --- |
| 1 | Admit now, or wait? | **Wait for AC1 live; merge with LM-4** | With no UI, admitting now gives nobody anything and adds a path no real model has tested. AC1 doesn't need admission: it drives `LocalExecution` directly. LM-4 can build against `lm5-admission` meanwhile |
| 2 | Install a model? Which? | **Yes: Ollama, already installed, with one tool-capable coding model you choose** | Every remaining native row needs one. I have no evidence on which model works, so the first run is the test. Choose one that fits this Mac's memory. Modex downloads nothing; the pull is yours |
| 3 | Phone or paired-desktop sends on a local thread? | **Refuse for v1, until those clients show the inference host** | A person on a phone could otherwise run a turn without seeing where it goes. **This needs code before admission:** `lm5-admission` doesn't refuse these sends today. It's a small guard with a test, in main |
| 4 | Clearing to cloud: revision check or confirmation? | **Confirmation in the UI; no revision check** | The risk is the next message going to a cloud model by surprise, so name that model in the confirmation. Clearing starts a fresh native conversation, and a revision guards nothing there |
| 5 | Answer #384? | **Yes: approve slices 1–2 as proposed** | They're a written finding and a disposable probe on the contributor's own machine, with no backend change. It has waited since October. Draft below; it isn't posted |

**Draft reply for #384:** "That scope works: go ahead with slices 1 and 2 as you described, and post the dated receipt here, including a negative result. Please stay out of the backend until #378 and #380 are accepted."

## Remaining human and native rows

All commands run from `apps/desktop` after `pnpm run build:main`. Save receipts outside the repo, then copy what's needed into `docs/reviews/`.

| Row | Who and what it needs | Launch command | Expected receipt |
| --- | --- | --- | --- |
| LM-3 AC1, shell read (#379) | Val; running server and model | `MODEX_LM3_LIVE=1 MODEX_LM3_URL=http://127.0.0.1:11434/v1 MODEX_LM3_MODEL=<model> MODEX_LM3_CONTEXT=<tokens> MODEX_LM3_REPORT=<dir> node --test --test-force-exit dist/test/local-codex-native.test.js` | Test passes; the report under `<dir>` holds request shapes, tools, the turn result and provenance. Add `MODEX_LM3_TOKEN` if the server needs one |
| LM-3 AC1, edit and test (#379) | Same | **No command exists.** The live test only does a shell read; the criterion also needs an edit and a test run, so it must be extended first | File bytes and test output from a disposable workspace, not success text |
| LM-5 AC2, offline canary (#380) | Val's authorization; model | **No harness exists.** It must deny the network to both Modex and the server, and needs building | A completed native coding smoke with the denied-network evidence and versions recorded |
| LM-5 AC4, real runtime (#380) | Val; model | **No command exists.** The AC4 tests run against a scripted server only | Overflow, OOM and restart each end failed or interrupted, with server logs, request and tool-run counts |
| LM-3 AC6, managed Mac (#379) | A managed Mac; none named | `MODEX_LM3_WIRE=1 MODEX_LM3_REPORT=<dir> node --test --test-force-exit dist/test/local-codex-native.test.js` with a policy that sets a governed key | The turn refuses before `thread/start`, naming the layer and key. A pass on this Mac proves nothing about managed policy |
| LM-2 AC1, real listing (#378) | Val's go; Ollama or LM Studio | **No launcher exists.** The approved path is a listing-only read through `LocalModelsService`, from a probe in `.probes/` | Runtime versions, the models returned, requests per route, and no pull, load or inference |
| LM-2 acceptance (#378) | Val | None | Acceptance or rejection recorded on #378 |
| LM-4 AC1 and AC4 (#381) | Val; after LM-4 and admission | Not built | A real task through the UI; VoiceOver results recorded separately |
| LM-6 runtimes (#382) | Runtimes, after LM-5 | `lm6-runtimes` holds one unpushed draft, owned elsewhere | Versioned native evidence per runtime |
| LM-7 Gate B and C (#383) | After the above | `e2e/local-model-acceptance.spec.ts` doesn't exist | [The evidence map](2026-11-03-lm7-evidence-map.md), filled in |

The fixture-level AC1, AC3, AC4 and AC5 for LM-5 come with #475. AC4 still has the real-runtime row above.

## Your next step

Answer the five questions. If you take the recommendations, the order is: land #475 and `lm-ready`, add the remote-send guard, pull a model and run LM-3 AC1, then start LM-4 on top of `lm5-admission`.
