# LM-5 known cloud-routed models (#380 step 3), 2026-10-30

Issue #380 remains open. This slice builds on the context-window evidence slice. It moves the refusal of known
cloud-routed and non-generative models from the renderer's model list into main. It does not admit product
local execution, and it does not verify where unmarked models run.

## What changed

- **`LocalModelDiscovery`.** The per-model record from the last ready listing also keeps `unselectable`
  (`cloud`, `embedding` or `other`) when the runtime marked the model that way. Its record of advertised
  context is unchanged.
- **`LocalExecution.validate`.** Refuses, before any process starts:
  - a model whose record says `cloud`;
  - on an Ollama connection, any model named `…:cloud` or `…-cloud` (`OLLAMA_CLOUD_NAME`), even if it was never
    listed;
  - a model whose record says `embedding` or `other`.
- **Unmarked models** remain unverified. Loopback is the configured destination, not verified locality.

## Verification

- **Execution suite.** A new regression covers five cases: a listed cloud model, two unlisted Ollama cloud names
  (`:cloud` and `-cloud`), a listed embedding model and a listed non-text model. Each is refused by `validate`
  and by the turn, and no process is spawned.
- **Ollama discovery case.** It now checks that main's record keeps `cloud` and `embedding`, and nothing for the
  generative coder.

**Negative controls.** Each guard was disabled in turn in the compiled output, and each made its regression fail:

- the listed-cloud check;
- the Ollama name check;
- the non-generative check;
- the discovery record.

The files were then restored, verified byte for byte with `cmp`, and both cases passed again.

**Results:**

- Focused suites (execution, discovery, runner local models, run-policy): 59/59.
- Full-check results are recorded in the PR.

## Still open on #380

- the network-denied offline canary (AC2);
- real-runtime overflow, OOM and restart handling (AC4);
- product admission, which is Val's decision.
