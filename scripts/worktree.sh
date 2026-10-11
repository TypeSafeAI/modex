#!/usr/bin/env bash
# See docs/worktree-hygiene.md. All removal uses the shared, recoverable pruning guard.
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec node "$script_dir/worktree-maintenance.mjs" "$@"
