#!/usr/bin/env bash
# Records free memory, swap and the eight largest processes every 10 s, for finding what pages a
# shared CI runner during the paired iPhone test (docs/status.md, Known rough edges). The simulator's
# own processes run on the host, so they show up here too.
#
#   sample-memory.sh <log>            sample until killed
#   sample-memory.sh --summary <log>  the lowest-free sample, and what was largest then
set -euo pipefail

if [[ "${1:-}" == "--summary" ]]; then
  awk '/^20/ { stamp = $0 }
    /memory free percentage/ { free = $NF + 0; keep = (min == "" || free < min); if (keep) { min = free; at = stamp; top = "" } }
    /^  / && keep { top = top "\n" $0 }
    END { if (min != "") printf "Lowest free memory %d%% at %s; largest processes then:%s\n", min, at, top }' "$2"
  exit 0
fi

log="$1"
mkdir -p "$(dirname "$log")"
while :; do
  {
    date -u +%Y-%m-%dT%H:%M:%SZ
    memory_pressure -Q | tail -1
    echo "swap $(sysctl -n vm.swapusage)"
    ps -Ao rss=,ucomm= | sort -rn | head -8 | awk '{ rss = $1; $1 = ""; printf "  %5d MB%s\n", rss / 1024, $0 }'
  } >> "$log" 2>&1
  sleep 10
done
