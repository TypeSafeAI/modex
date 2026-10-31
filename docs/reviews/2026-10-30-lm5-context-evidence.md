# LM-5 context-window evidence (#380 AC6), 2026-10-30

Issue #380 remains open. This slice is cut from `main` at `f51ef7e`. It records where a local child's context
window comes from, and refuses a window larger than the runtime advertised. It does not admit product local
execution: `main` still constructs no `LocalExecution`. It qualifies no runtime and observes no loaded context.

## What changed

- **`LocalModelDiscovery`**
  - New `advertisedContext(model)`. It returns the advertised context from the last *ready* listing of
    the model's connection revision, with its `checkedAt`.
  - The value is null when the listing advertised no context.
  - It is undefined for a model that was never listed, a typed (manual) model, or after the connection
    was edited or deleted (`invalidate`).
  - A failed listing neither adds nor erases the record.
- **`LocalExecution`**
  - A new optional constructor parameter reads that record.
  - `validate` refuses a window above a known advertised maximum, before any process starts.
  - The admitted provenance gains `context`: `{ configured, source: "person", effective, advertised, loaded:
    "unknown" }`. `advertised` is the record or `"not-checked"`.
  - `effective` is the window admission found in the child's `config/read`, which it requires to equal
    `configured`.

No runtime reports the context it actually loaded a model with, so `loaded` stays unknown rather than assumed.

## Verification

Two new regressions:

- **`local-model-execution.test.ts`**
  - An advertised 16,384 against a configured 32,768 is refused by `validate` and by the turn, with no
    process spawned.
  - With an advertised maximum, with none advertised and without any record, the provenance records
    each case exactly.
- **`local-model-discovery.test.ts`**
  - A listed model with `max_model_len` keeps it. A listed model without one keeps null. A typed model
    has nothing.
  - A failed listing keeps the earlier record.
  - An edit and invalidate clear it, for both the old and the new revision.

**Negative controls.** Each guard was disabled in turn in the compiled `dist` output:

- the refusal;
- the provenance `context`;
- the discovery record;
- the invalidate cleanup.

Each made its regression fail. The files were then restored, verified byte for byte with `cmp`, and both
cases passed again.

**Results:**

- Focused suites (execution, discovery, run-policy, runner local models): 58/58.
- Full-check results are recorded in the PR.

## Still open on #380

- the native network-denied offline canary (AC2), which needs Val's authorization and an installed local coding
  model;
- overflow, OOM and restart behaviour against a real runtime (AC4);
- wiring discovery's record into a constructed `LocalExecution` happens with product admission, which is
  Val's decision.
