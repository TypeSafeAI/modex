#!/usr/bin/env bash
# Build, sign with a Developer ID, notarize, staple and verify the macOS release artifacts.
#
#   scripts/release-mac.sh              # full run: build → sign → notarize → staple → verify → checksums
#   scripts/release-mac.sh --sign-only  # rehearsal: Developer ID + hardened runtime, no notary upload
#   scripts/release-mac.sh --verify     # verify an existing apps/desktop/release/ only
#   scripts/release-mac.sh --verify --sign-only   # same, for a rehearsal build
#
# Credentials come from the environment, or from .env.release (git-ignored) resolved through
# `op run` when 1Password's CLI is installed. Notarization takes either an App Store Connect API
# key (APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER) or a notarytool keychain profile
# (APPLE_KEYCHAIN_PROFILE, created once with `xcrun notarytool store-credentials`). Nothing here
# prints a secret: identity names and key ids are the only values echoed, and both are public in
# the signed app anyway.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
desktop="$root/apps/desktop"
app="$desktop/release/mac-arm64/Modex.app"
mode="${1:-build}"

say() { printf '\033[1m== %s\033[0m\n' "$*"; }
die() { printf 'release-mac: %s\n' "$*" >&2; exit 1; }

# Releases build in a worktree (AGENTS.md); the primary checkout only receives `git pull` and its
# node_modules is not kept complete. Keep one .env.release in the primary checkout: a worktree
# without its own falls back to that one.
primary="$(cd "$(git -C "$root" rev-parse --path-format=absolute --git-common-dir)/.." && pwd)"
if [ "$mode" != "--verify" ] && [ -z "${MODEX_RELEASE_CI:-}" ] && [ "$root" = "$primary" ]; then
  die "run this from a release worktree, not the primary checkout: scripts/worktree.sh new release-<version>, cd into it, re-run"
fi
env_file="$root/.env.release"
[ -f "$env_file" ] || env_file="$primary/.env.release"

# Re-exec under `op run` so secret references in .env.release are resolved in memory.
if [ -z "${MODEX_RELEASE_ENV_LOADED:-}" ] && [ -f "$env_file" ]; then
  command -v op >/dev/null || die "$env_file present but the 1Password CLI (op) is not installed"
  export MODEX_RELEASE_ENV_LOADED=1
  exec op run --env-file="$env_file" -- "$0" "$@"
fi

[ "$(uname)" = Darwin ] || die "macOS only"
[ "$(uname -m)" = arm64 ] || die "build on Apple Silicon: the artifacts are arm64 and the packaged e2e must run natively"

verify() {
  local notarized="${1:-true}"
  say "codesign: strict deep verification"
  codesign --verify --deep --strict --verbose=2 "$app"
  say "codesign: Developer ID authority and hardened runtime"
  local info; info="$(codesign -dvv "$app" 2>&1)"
  grep -q 'Authority=Developer ID Application' <<<"$info" || die "app is not signed with a Developer ID certificate"
  grep -Eq 'flags=0x[0-9a-f]+\(.*runtime' <<<"$info" || die "hardened runtime flag is missing"
  grep -q 'TeamIdentifier=' <<<"$info" && grep 'TeamIdentifier=' <<<"$info"
  if [ -n "${MODEX_SIGN_HASH:-}" ]; then
    say "leaf certificate is the one selected"
    local certs; certs="$(mktemp -d)"
    codesign -d --extract-certificates="$certs/c" "$app" 2>/dev/null
    local leaf; leaf="$(openssl x509 -inform DER -in "$certs/c0" -noout -fingerprint -sha1 | sed 's/.*=//; s/://g')"
    rm -rf "$certs"
    [ "$leaf" = "$(tr '[:lower:]' '[:upper:]' <<<"$MODEX_SIGN_HASH")" ] || die "app signed with certificate $leaf, expected $MODEX_SIGN_HASH"
    echo "leaf $leaf"
  fi
  say "entitlements: JIT allowed, library validation kept"
  local ents; ents="$(codesign -d --entitlements - --xml "$app" 2>/dev/null)"
  grep -q 'com.apple.security.cs.allow-jit' <<<"$ents" || die "allow-jit entitlement missing"
  grep -q 'disable-library-validation' <<<"$ents" && die "library validation is disabled; the build loads something unsigned"
  say "nested code is signed by the same team (node-pty, spawn-helper, terminal supervisor)"
  local team; team="$(grep -o 'TeamIdentifier=[A-Z0-9]*' <<<"$info" | head -1)"
  while IFS= read -r bin; do
    local t; t="$(codesign -dvv "$bin" 2>&1 | grep -o 'TeamIdentifier=[A-Z0-9]*' | head -1 || true)"
    [ "$t" = "$team" ] || die "$bin is signed by '$t', expected '$team'"
  done < <(find "$app/Contents/Resources/app.asar.unpacked" -type f \( -name '*.node' -o -perm -u+x \) 2>/dev/null)
  local dmg zip; dmg="$(ls "$desktop"/release/Modex-*-arm64.dmg)"; zip="$(ls "$desktop"/release/Modex-*-arm64.zip)"
  if [ "$notarized" = true ]; then
    say "Gatekeeper: assessment on the notarized app"
    spctl -a -vv -t exec "$app" 2>&1 | tee /dev/stderr | grep -q 'source=Notarized Developer ID' || die "Gatekeeper does not see a notarized Developer ID app"
    say "stapler: ticket attached to the app and the DMG"
    xcrun stapler validate "$app"
    xcrun stapler validate "$dmg"
    say "zip: the app inside carries the ticket too"
    local tmp; tmp="$(mktemp -d)"; unzip -q "$zip" -d "$tmp"; xcrun stapler validate "$tmp/Modex.app"; rm -rf "$tmp"
  else
    say "Gatekeeper: skipped (not notarized)"
  fi
  say "container integrity"
  hdiutil verify "$dmg" >/dev/null && echo "dmg ok"
  unzip -tq "$zip"
  say "version and architecture"
  /usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$app/Contents/Info.plist"
  lipo -archs "$app/Contents/MacOS/Modex"
  say "checksums"
  (cd "$desktop/release" && shasum -a 256 "$(basename "$dmg")" "$(basename "$zip")" | tee SHA256SUMS.txt)
}

notarize=true
case "$mode" in
  --verify) if [ "${2:-}" = "--sign-only" ]; then verify false; else verify; fi; exit 0;;
  --sign-only) notarize=false;;
  build) ;;
  *) die "unknown argument: $mode";;
esac

say "dependencies"
for dep in node-pty electron electron-builder @electron/osx-sign; do
  [ -f "$root/node_modules/$dep/package.json" ] || die "node_modules/$dep is missing; run \`npm ci\` in $root first"
done
echo "node_modules complete"

say "credentials"
: "${MODEX_SIGN_IDENTITY:?set MODEX_SIGN_IDENTITY to the Developer ID Application identity}"
if [ "$notarize" = true ]; then
  if [ -n "${APPLE_KEYCHAIN_PROFILE:-}" ]; then
    echo "notary: keychain profile $APPLE_KEYCHAIN_PROFILE"
  else
    : "${APPLE_API_KEY:?set APPLE_API_KEY to the App Store Connect .p8 path, or APPLE_KEYCHAIN_PROFILE}"
    : "${APPLE_API_KEY_ID:?set APPLE_API_KEY_ID}"
    : "${APPLE_API_ISSUER:?set APPLE_API_ISSUER}"
    [ -f "$APPLE_API_KEY" ] || die "APPLE_API_KEY file not found: $APPLE_API_KEY"
    [ "$(/usr/bin/stat -f '%Lp' "$APPLE_API_KEY")" = 600 ] || die "APPLE_API_KEY must be mode 600 (chmod 600 '$APPLE_API_KEY')"
    case "$APPLE_API_KEY" in "$root"/*) die "the .p8 must live outside the repository";; esac
    echo "notary: api key id $APPLE_API_KEY_ID (issuer and key contents not shown)"
  fi
else
  echo "notary: skipped (--sign-only rehearsal; do not publish this build)"
fi
if [ -z "${MODEX_RELEASE_CI:-}" ]; then
  security find-identity -v -p codesigning | grep -Fq "\"$MODEX_SIGN_IDENTITY\"" || die "identity not in the keychain: $MODEX_SIGN_IDENTITY"
  # A renewed certificate sits next to the one it replaced under the same name, and codesign
  # refuses an ambiguous name. Resolve the exact certificate: MODEX_SIGN_HASH if given, else the
  # matching certificate that expires last.
  if [ -z "${MODEX_SIGN_HASH:-}" ]; then
    MODEX_SIGN_HASH="$(security find-certificate -a -c "$MODEX_SIGN_IDENTITY" -Z -p | python3 -c '
import sys, subprocess, re
text = sys.stdin.read()
best = None
for m in re.finditer(r"SHA-1 hash: ([0-9A-F]{40})\n(-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----)", text, re.S):
    end = subprocess.run(["openssl", "x509", "-noout", "-enddate"], input=m.group(2).encode(), capture_output=True).stdout.decode().strip()
    if best is None or end > best[1]: best = (m.group(1), end)
print(best[0] if best else "")')"
    [ -n "$MODEX_SIGN_HASH" ] || die "could not resolve a certificate hash for: $MODEX_SIGN_IDENTITY"
  fi
  export MODEX_SIGN_HASH
fi
echo "identity: $MODEX_SIGN_IDENTITY${MODEX_SIGN_HASH:+ (certificate $MODEX_SIGN_HASH)}"

say "build, sign${notarize:+, notarize, staple}"
# Local: pick the identity by name from the login keychain. CI: electron-builder imports CSC_LINK
# into a temporary keychain and signs with the identity found there, so CSC_NAME would not resolve.
# electron-builder takes the name without the "Developer ID Application:" prefix and adds it back.
if [ -z "${MODEX_RELEASE_CI:-}" ]; then export CSC_NAME="${MODEX_SIGN_IDENTITY#Developer ID Application: }"; fi
if [ "$notarize" = true ]; then (cd "$desktop" && npm run dist:release)
else (cd "$desktop" && npm run dist:release -- -c.mac.notarize=false); fi

verify "$notarize"
say "done: apps/desktop/release/"
