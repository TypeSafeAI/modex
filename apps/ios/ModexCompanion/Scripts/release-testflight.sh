#!/usr/bin/env bash
set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
archive_path="${MODEX_IOS_ARCHIVE_PATH:-$app_dir/build/ModexCompanion.xcarchive}"
export_dir="${MODEX_IOS_EXPORT_DIR:-$app_dir/build/export}"
derived_data="${MODEX_IOS_DERIVED_DATA:-$app_dir/build/DerivedData}"
for name in APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER; do
  if [[ -z "${!name:-}" ]]; then echo "Missing $name. Run under op run with .env.release." >&2; exit 1; fi
done
if [[ ! -f "$APPLE_API_KEY" ]]; then echo "App Store Connect key file is unavailable." >&2; exit 1; fi

cd "$app_dir"
xcodegen generate
xcodebuild -quiet -project ModexCompanion.xcodeproj -scheme ModexCompanion \
  -destination 'generic/platform=iOS' -archivePath "$archive_path" -derivedDataPath "$derived_data" \
  -allowProvisioningUpdates -authenticationKeyPath "$APPLE_API_KEY" \
  -authenticationKeyID "$APPLE_API_KEY_ID" -authenticationKeyIssuerID "$APPLE_API_ISSUER" \
  archive
xcodebuild -quiet -exportArchive -archivePath "$archive_path" -exportPath "$export_dir" \
  -exportOptionsPlist Scripts/ExportOptions.plist -allowProvisioningUpdates \
  -authenticationKeyPath "$APPLE_API_KEY" -authenticationKeyID "$APPLE_API_KEY_ID" \
  -authenticationKeyIssuerID "$APPLE_API_ISSUER"
ipa="$export_dir/ModexCompanion.ipa"
if [[ ! -f "$ipa" ]]; then echo "Expected IPA was not exported at $ipa." >&2; exit 1; fi
unzip -tq "$ipa"
xcrun altool --validate-app "$ipa" --api-key "$APPLE_API_KEY_ID" \
  --api-issuer "$APPLE_API_ISSUER" --p8-file-path "$APPLE_API_KEY"
xcrun altool --upload-package "$ipa" --wait --api-key "$APPLE_API_KEY_ID" \
  --api-issuer "$APPLE_API_ISSUER" --p8-file-path "$APPLE_API_KEY"
