#!/bin/sh
# Runs both processes in one container:
#   - operator console  → OPERATOR_CONSOLE_PORT (default 3502)
#   - MCP HTTP bridge   → PORT (default 3600, kept in foreground)
# The console reads PORT first, so it is launched with PORT overridden to the
# console port; the bridge keeps the container-level PORT.
set -e

CONSOLE_PORT="${OPERATOR_CONSOLE_PORT:-3502}"

echo "[entrypoint] starting operator console on ${CONSOLE_PORT}"
PORT="${CONSOLE_PORT}" pnpm exec tsx apps/operator-console/src/server.ts &

echo "[entrypoint] starting MCP HTTP bridge on ${PORT:-3600}"
exec pnpm exec tsx apps/http-bridge/src/server.ts
