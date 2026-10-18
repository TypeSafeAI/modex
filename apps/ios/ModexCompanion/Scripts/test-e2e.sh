#!/usr/bin/env bash
set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_dir="$(cd "$app_dir/../../.." && pwd)"
fixture_file="$(mktemp /tmp/modex-ios-pairing.XXXXXX)"
local_pairing="$app_dir/UITests/LocalPairing.json"
fixture_pid=""
sampler_pid=""
# CI failures in this test came from the whole runner paging (docs/status.md, Known rough edges).
# With MODEX_IOS_MEMORY_LOG set, sample free memory, swap and the largest processes every 10 s.
memory_log="${MODEX_IOS_MEMORY_LOG:-}"
memory_summary() {
  awk '/memory free percentage/ { free = $NF + 0; if (min == "" || free < min) { min = free; at = stamp; keep = 1; top = "" } else keep = 0 }
    /^20/ { stamp = $0 } /^  / && keep { top = top "\n" $0 }
    END { if (min != "") printf "Lowest free memory %d%% at %s; largest processes then:%s\n", min, at, top }' "$memory_log"
}
cleanup() {
  rm -f "$local_pairing" "$fixture_file"
  if [[ -n "$fixture_pid" ]]; then kill -TERM "$fixture_pid" 2>/dev/null || true; wait "$fixture_pid" 2>/dev/null || true; fi
  if [[ -n "$sampler_pid" ]]; then kill "$sampler_pid" 2>/dev/null || true; memory_summary || true; fi
}
trap cleanup EXIT
if [[ -n "$memory_log" ]]; then
  mkdir -p "$(dirname "$memory_log")"
  while :; do
    {
      date -u +%Y-%m-%dT%H:%M:%SZ
      memory_pressure -Q | tail -1
      echo "swap $(sysctl -n vm.swapusage)"
      ps -Ao rss=,ucomm= | sort -rn | head -8 | awk '{ rss = $1; $1 = ""; printf "  %5d MB%s\n", rss / 1024, $0 }'
    } >> "$memory_log" 2>&1
    sleep 10
  done &
  sampler_pid=$!
fi

cd "$repo_dir"
pnpm --filter @modex/desktop build
MODEX_IOS_LAN=1 node "$app_dir/Scripts/fixture.mjs" "$fixture_file" &
fixture_pid=$!
for _ in {1..100}; do
  if [[ -s "$fixture_file" ]]; then break; fi
  if ! kill -0 "$fixture_pid" 2>/dev/null; then echo "Companion fixture exited before pairing." >&2; exit 1; fi
  sleep 0.2
done
if [[ ! -s "$fixture_file" ]]; then echo "Companion fixture did not become ready." >&2; exit 1; fi
cp "$fixture_file" "$local_pairing"

cd "$app_dir"
xcodegen generate
destination="${MODEX_IOS_DESTINATION:-platform=iOS Simulator,name=iPhone 16 Pro,OS=26.5}"
derived_data="${MODEX_IOS_DERIVED_DATA:-/tmp/modex-ios-e2e-derived}"
configuration="${MODEX_IOS_CONFIGURATION:-Debug}"
xcodebuild -quiet -project ModexCompanion.xcodeproj -scheme ModexCompanion \
  -destination "$destination" -derivedDataPath "$derived_data" -configuration "$configuration" \
  -parallel-testing-enabled NO CODE_SIGNING_ALLOWED=NO ENABLE_TESTABILITY=YES build-for-testing
xctestrun="$(find "$derived_data/Build/Products" -maxdepth 1 -name 'ModexCompanion_*.xctestrun' -print -quit)"
if [[ -z "$xctestrun" ]]; then echo "Xcode did not create an iPhone test plan." >&2; exit 1; fi
# A shared CI runner takes 5–30× longer than a developer Mac on every XCTest round trip (see
# UITestBudget in UITests/XCUIElement+Ready.swift). Every UI-test wait is multiplied by this;
# xcodebuild hands TEST_RUNNER_* variables to the test runner's environment.
timeout_scale="${MODEX_UI_TIMEOUT_SCALE:-1}"
TEST_RUNNER_MODEX_UI_TIMEOUT_SCALE="$timeout_scale" xcodebuild -xctestrun "$xctestrun" -destination "$destination" \
  -parallel-testing-enabled NO -only-testing:ModexCompanionUITests/DemoWorkspaceTests -only-testing:ModexCompanionUITests/CompanionFlowTests test-without-building
