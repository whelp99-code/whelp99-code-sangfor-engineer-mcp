#!/usr/bin/env bash
# Entry for mcp-scorecard / MCP_PROBE audits (uses tsx so workspace packages resolve).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"
exec pnpm exec tsx apps/mcp-server/src/index.ts
