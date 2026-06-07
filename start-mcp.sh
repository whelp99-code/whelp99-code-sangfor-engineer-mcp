#!/bin/bash
cd "$(dirname "$0")"
exec ./node_modules/.bin/tsx apps/mcp-server/src/index.ts
