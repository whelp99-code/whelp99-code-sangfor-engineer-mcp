#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
rerank_venv="${SANGFOR_EMBEDDING_SERVER_VENV:-$repo_root/.venv-embed}"
exec "$rerank_venv/bin/python" -m uvicorn rerank_server:app \
  --app-dir "$repo_root/automation/embedding-server" --host 127.0.0.1 \
  --port "${SANGFOR_LOCAL_RERANK_PORT:-8005}" --log-level warning
