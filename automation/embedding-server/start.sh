#!/usr/bin/env bash
# Start the local embeddings endpoint the RAG `rapid-mlx` provider expects
# (http://127.0.0.1:8000/v1). Loopback-only by design.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
venv="${SANGFOR_EMBEDDING_SERVER_VENV:-$repo_root/.venv-embed}"
host="${SANGFOR_EMBEDDING_SERVER_HOST:-127.0.0.1}"
port="${SANGFOR_EMBEDDING_SERVER_PORT:-8000}"

if [[ ! -x "$venv/bin/python" ]]; then
  echo "missing venv at $venv — create it with:" >&2
  echo "  uv venv --python 3.12 $venv" >&2
  echo "  uv pip install --python $venv/bin/python torch --index-url https://download.pytorch.org/whl/cpu" >&2
  echo "  uv pip install --python $venv/bin/python sentence-transformers fastapi 'uvicorn[standard]'" >&2
  exit 1
fi

exec "$venv/bin/python" -m uvicorn server:app \
  --app-dir "$repo_root/automation/embedding-server" \
  --host "$host" --port "$port" --log-level warning
