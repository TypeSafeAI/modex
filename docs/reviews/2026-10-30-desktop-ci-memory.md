# Desktop CI resource evidence

The #456 merge-queue run 41056164788 failed the approved 500 ms cold transcript gate with a 781.9 ms median across five fresh launches. Its trace records long renderer tasks but no contemporaneous runner memory or swap samples. Local CPU profiling did not reproduce the hosted slowdown, and reusing Markdown parser configuration produced no observed end-to-end improvement. Neither result clears the failed gate.

This change starts the existing iPhone CI memory sampler in the desktop job after checkout, prints its low-memory summary, and retains the timestamped log in a separate desktop-runner-memory artifact even when tests fail. It records free memory, swap usage, and the eight largest processes by resident memory using process names without command arguments. Sampling runs every ten seconds and has observer overhead; a correlation would be evidence for investigation, not proof of causation.

The change leaves the five fresh-launch measurements, 500 ms threshold, test assertions, retry behavior, and job timeout unchanged. It does not retry #456 or claim to repair performance. Hosted collection must be verified on this revision before relying on the new artifact.

Local `pnpm build && pnpm test` passed: 2,271 tests passed, 26 skipped, zero failures. The existing sampler produced a timestamped memory/swap/process sample and a nonempty summary in a local smoke check. Actionlint passed after excluding its pre-existing unsupported `code-quality` permission; the initial lint result is retained. Independent static review found no actionable findings. Hosted collection and protected validation remain pending.
