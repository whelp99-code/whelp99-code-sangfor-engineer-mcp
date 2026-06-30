# Sangfor Engineer MCP — HTTP bridge (port 3600) + operator console option (3502)
# Runs from TypeScript source via tsx because http-bridge spawns `pnpm exec tsx`
# against apps/mcp-server/src/index.ts at runtime.
#
# node:20 matches the host and .nvmrc (one version story; see A9 in the plan).
FROM node:20-alpine AS base
RUN apk add --no-cache bash \
 && corepack enable \
 && corepack prepare pnpm@10.28.1 --activate

# Dependencies — copy every workspace manifest (apps/* + packages/*)
FROM base AS deps
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps ./apps
COPY packages ./packages
# Keep only package.json files so install layer is stable when sources change
RUN find apps packages -type f ! -name 'package.json' -delete \
 && find apps packages -type d -empty -delete 2>/dev/null || true

RUN pnpm install --frozen-lockfile --prod=false || pnpm install --prod=false

# Runner — full source needed for tsx
FROM base AS runner
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# `COPY . .` brings the source for apps/* + packages/* but NOT the per-package
# node_modules symlinks pnpm created in the deps stage. Workspace-package deps
# (e.g. packages/sangfor-pptx → pptxgenjs) therefore fail to resolve at runtime
# and crash the spawned MCP server. Re-link against the copied store so every
# packages/*/node_modules symlink is recreated. The store is already present,
# so this is fast.
RUN pnpm install --frozen-lockfile --prod=false --offline \
 || pnpm install --frozen-lockfile --prod=false \
 || pnpm install --prod=false

ENV NODE_ENV=production
ENV PORT=3600

EXPOSE 3600
EXPOSE 3502

# Run both the HTTP bridge (3600) and the operator console (3502) in one container
RUN chmod +x docker-entrypoint.sh
CMD ["./docker-entrypoint.sh"]
