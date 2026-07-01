#!/usr/bin/env bash
set -euo pipefail
REPO="${1:-.}"
shift || true
WRAPPER="$(cd "$(dirname "$0")" && pwd)/with-memory.sh"
exec "$WRAPPER" cursor "$@"
