#!/usr/bin/env bash
# The native Linux harness is pinned to Ubuntu 24.04 for KWallet5.
# Override only this invocation's package sources; keep the image's resolver/configuration intact.
set -euo pipefail

if [[ "${GITHUB_ACTIONS:-}" != true || "${RUNNER_OS:-}" != Linux ]]; then
  echo 'Linux installed-app host preparation requires a Linux GitHub Actions runner.' >&2
  exit 2
fi
if [[ "${1:-}" != noble ]]; then
  echo 'The KWallet5 installed-app harness requires the pinned Ubuntu Noble runner.' >&2
  exit 2
fi
if [[ "${RUNNER_TEMP:-}" != /* || ! -d "${RUNNER_TEMP:-}" ]]; then
  echo 'RUNNER_TEMP must name the existing absolute runner temporary directory.' >&2
  exit 2
fi

modex_apt_dir=$(mktemp -d "${RUNNER_TEMP%/}/modex-native-apt.XXXXXX")
trap 'rm -rf -- "$modex_apt_dir"' EXIT
mkdir "$modex_apt_dir/sourceparts"
cat > "$modex_apt_dir/ubuntu.sources" <<'SOURCES'
Types: deb
URIs: https://archive.ubuntu.com/ubuntu
Suites: noble noble-updates noble-backports
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: https://security.ubuntu.com/ubuntu
Suites: noble-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
SOURCES

modex_apt_options=(
  -o "Dir::Etc::sourcelist=$modex_apt_dir/ubuntu.sources"
  -o "Dir::Etc::sourceparts=$modex_apt_dir/sourceparts"
  -o Acquire::Retries=1
  -o Acquire::http::Timeout=15
  -o Acquire::https::Timeout=15
  -o APT::Update::Error-Mode=any
)
sudo apt-get "${modex_apt_options[@]}" update
sudo apt-get "${modex_apt_options[@]}" install -y \
  xvfb libgbm1 libasound2t64 dbus gnome-keyring libsecret-1-0 \
  libglib2.0-bin libfuse2t64 libkf5wallet-bin
