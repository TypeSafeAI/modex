# Local models: global Codex config bytes and token records, 2026-11-03

Built on `main` at `b785054e88836ac9df5ca917425031ab697d4d30`. Independent of open #475. Local execution stays unadmitted: `main/index.ts` constructs no `LocalExecution`. This adds one product change, streaming redaction, in code the product does not reach yet.

## LM-3 AC4: `~/.codex/config.toml` keeps its bytes (#379)

`test/local-global-config.test.ts` points the test process's `HOME` and `CODEX_HOME` at a throwaway home holding a known file, then runs a local turn. The scripted child finds its home the way Codex does, from the environment Modex gave it, and writes there. The test compares bytes, SHA-256, modified time and the home's file list. The write landing in the private home is the positive control.

**Failed with the guard removed:** handing the child the person's `HOME` and `CODEX_HOME` changed the digest and failed the test.

**Installed Codex:** with `MODEX_LM3_WIRE=1`, the existing wire test on codex-cli 0.166.0 against a scripted loopback server now makes the same comparison. It used no model and no inference. It compares the throwaway home, not the real one. The real `~/.codex/config.toml` kept its modified time and size across the run; that is a `stat` observation, and its contents were never read.

Not covered: AC4's other half, a full regression on current `main` once #475 lands, and behaviour on a real runtime.

## LM-2 AC3: token in diagnostics and exports (#378)

`test/local-token-records.test.ts` runs a real `ThreadRunner` and `LocalExecution` over a scripted Codex whose message, tool command, tool output, stderr, `error` notification, failed turn and crash output all repeat the connection's token. It checks renderer events, the thread snapshot and items, the configuration provenance and every file under the home. That includes `secrets.json`, the routing receipts and the kept tool log. Each check first requires that the scripted output reached a record, so an empty record can't pass.

**A real leak, found and fixed.** `CodexBackend` redacts line by line, so a token split across two streamed deltas was rebuilt in `item_update` renderer events. A loopback server receives the token in its `Authorization` header, so it could do this. `local-models/redacting-sink.ts` now holds back the end of each stream while it could still become the token, for message, reasoning and tool output, including the raw stream kept as a tool log.

**Failed with each guard removed:**

| Removed | Result |
| --- | --- |
| The backend's line redaction | 4 of 5 tests fail: `the token reached renderer events` |
| The streaming sink | The split-delta test fails with the same message |

The fifth test sends a discovery failure that repeats the token in its status body and a header, and checks every reply. It passed from the start, and no mutation of discovery was run, so it documents existing behaviour rather than proving a guard.

**Export surfaces at this SHA.** Modex has no transcript or thread export. `space:export` writes a Notes page and `images:export` an image; local turns are refused Modex's note tools. `clipboard:write` copies text the renderer already holds, which the renderer-event check covers. A future transcript export needs its own check.

**Known limit.** A tool's displayed output keeps only its last 256 KiB. If that cut falls inside a token, the rest of the token stays visible, because what remains no longer matches. The whole token never appears. A model can reach this only by having the token repeated to it, and the token is not in model input.

**Evidence level.** All of this is fixture evidence with a scripted Codex. No real runtime or model ran.

## LM-2 step 6: cold-load explanation

`docs/local-models.md` now explains it. The in-app text is deferred to LM-4 (#381), because no local-model UI exists; the wording is in `docs/design/local-models-settings.md`.
