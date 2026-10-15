#!/usr/bin/env python3
"""Total XCTest's own steps in a UI-test Session log, so a CI failure is read from numbers.

An `iPhone companion` failure names one line, but the time usually went into XCTest's round trips
to the simulator (idle waits, launches, SpringBoard interruption checks, snapshots). This prints the
operations that took the most time, with how often each ran and its single longest occurrence,
for comparison with a green run of the same job.

    gh run download <run id> -R TypeSafeAI/modex -n iphone-test-results -D <empty dir>
    X=$(find <dir> -path '*DerivedData*' -name '*.xcresult' -print -quit)
    ID=$(xcrun xcresulttool get --legacy --format json --path "$X" \\
         | python3 -c 'import json,sys; j=json.load(sys.stdin); print(j["actions"]["_values"][0]["actionResult"]["diagnosticsRef"]["id"]["_value"])')
    xcrun xcresulttool export --legacy --type directory --path "$X" --id "$ID" --output-path <dir>/diag
    apps/ios/ModexCompanion/Scripts/xctest-activity-times.py $(find <dir>/diag -name 'Session-*.log' | head -1)

Parent activities include their children ("Tap" contains "Wait for … to idle"), so the totals
overlap; read the maxima to see which single steps approach the suite's budgets.
"""
import collections
import re
import sys


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    log = sys.argv[1]
    top = int(sys.argv[2]) if len(sys.argv) > 2 else 12
    text = open(log, errors="ignore").read()
    finished = re.compile(r"didFinishActivity:<XCActivityRecord: 0x[0-9a-f]+> [0-9: +-]+: (.*) \(([0-9.]+)s\)\s*$")
    by_step: dict[str, list[float]] = collections.defaultdict(list)
    for line in text.splitlines():
        m = finished.search(line)
        if not m:
            continue
        step = m.group(1)
        step = re.sub(r'"[^"]*"', '"…"', step)
        step = re.sub(r"`[^`]*`", "`…`", step)
        step = re.sub(r"'[^']*'", "'…'", step)
        step = re.sub(r"\d+(\.\d+)?", "N", step)
        by_step[step].append(float(m.group(2)))
    suites = re.findall(r"Executed \d+ tests?, with \d+ failures? .* in [0-9.]+ \([0-9.]+\) seconds", text)
    print(f"suite: {suites[-1] if suites else 'no suite summary in this log'}")
    for step, durations in sorted(by_step.items(), key=lambda kv: -sum(kv[1]))[:top]:
        print(f"  total {sum(durations):7.1f}s  n={len(durations):3d}  max {max(durations):5.1f}s  {step[:88]}")
    failures = [l.split("error: ", 1)[1] for l in text.splitlines() if " error: -[" in l]
    for f in failures[:3]:
        print(f"failure: {f[:200]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
