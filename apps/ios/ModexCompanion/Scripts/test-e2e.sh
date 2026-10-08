#!/usr/bin/env bash
set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_dir="$(cd "$app_dir/../../.." && pwd)"
fixture_file="$(mktemp /tmp/modex-ios-pairing.XXXXXX)"
local_pairing="$app_dir/UITests/LocalPairing.json"
fixture_pid=""
cleanup() {
  rm -f "$local_pairing" "$fixture_file"
  if [[ -n "$fixture_pid" ]]; then kill -TERM "$fixture_pid" 2>/dev/null || true; wait "$fixture_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT

cd "$repo_dir"
npm run build -w @modex/desktop
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
xcodebuild -xctestrun "$xctestrun" -destination "$destination" \
  -parallel-testing-enabled NO -only-testing:ModexCompanionUITests/DemoWorkspaceTests -only-testing:ModexCompanionUITests/CompanionFlowTests test-without-building
