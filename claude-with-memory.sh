#!/usr/bin/env bash
set -euo pipefail
REPO="${1:-.}"
shift || true
WRAPPER="$(cd "$(dirname "$0")" && pwd)/with-memory.sh"
if [[ "${2:-}" != "--print" ]]; then
  set -- "$REPO" --print "$@"
else
  set -- "$REPO" "$@"
fi
exec "$WRAPPER" "$@"
