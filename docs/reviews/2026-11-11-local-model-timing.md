# Recorded local-model cold-start and continuation timings

## Identity and scope

This is a read-only timing audit of the already completed network-denied fixture on source `7d6094e9ffc501b8d99f673cc2e9604b5c7bf5fe`, tree `f997226f508c9ad778ba38db0bbcdf08299e3375`. This analysis starts no model runtime and sends no inference request. The original run used Apple M5 Max, 128 GiB RAM, macOS 27.2.0 arm64, Codex 0.167.0 and Ollama 0.40.16 with `qwen3-coder:30b`, digest `06c1097efce0431c2045fe7b2e5108366e43bee1b4603a7aded8f21689e90bca`. Configured and observed loaded context was 65,536. The [integration qualification](2026-11-11-closeout-qualification.md) records its functional checks and boundary separately.

## Observations

| Interval | Recorded duration | What it includes |
| --- | --- | --- |
| First native read stage | 14.194 s | Connection/thread setup, private Codex startup/configuration, the first model load, an observed file-read tool and reply |
| Model runner startup reported by Ollama | 9.06 s | One logged runner launch and model-load cycle, within the first read stage |
| Following approved edit/test stage | 3.761 s | Explicit same-session continuation, approval callbacks, actual fixture edit, independent test and reply after the read completed |
| Whole native test workflow | 18.126 s | Both stages plus fixture connection/thread setup, disposal and configuration verification |

The runtime log contains one runner-start record, one model-loading record and two identical ready markers reporting 9.06 seconds; those markers are not two loads and must not be summed. Its five Responses requests returned HTTP 200 with rounded request durations of 12.99 s, 337.81 ms, 1.45 s, 535.35 ms and 1.45 s. These are complete HTTP request durations, not first-token latency or token throughput. Runner startup overlaps the first read interval, and stage durations are contained in the workflow total. The native test clocks exclude the outer owned-service launcher and sandbox preflight, which ran earlier.

The service and model runner were newly started for the fixture. Disk/page caches and other work on the shared host were not controlled. The subsequent turn reused the session after the successful read and the single logged load cycle. Its edit/test task differs from the initial read, so these two durations describe observed cold-start and warm-continuation behavior rather than a speedup comparison. This is one historical observation; it supplies neither a universal latency target nor current-head or all-platform performance qualification.

## Audit and remaining gates

The audit checks the original successful driver, both stages, unchanged before/after runtime identities, approved digest observations, five HTTP outcomes and the original timing harness. The exact AC1 harness body at the recorded source matches the current checkout; its Date.now intervals establish the scopes above. The extractor and `native-cold-warm-timing-7d6094e-audit.json` retain hashes of all five receipt/log inputs under `/Users/buns/Documents/Codex/2026-11-11/modex-closeout/`, outside disposable worktrees. No new inference or timing sample is represented by this analysis.

The separate inherited boundary receipts establish their external-TCP and outside-write denial checks for the owned server and Codex descendants. The server also logged failed background metadata refresh attempts; network-denied execution must not be presented as zero remote attempts. These timings do not repair the later repeated-read compaction finding or dense-context overflow, establish genuine OOM recovery, admit product execution, complete the runtime matrix or supply human/device acceptance. LM-7 remains open; newer source/runtime combinations and repeatability retain their own qualification gates.
