# Development improvements (2026-06-03)

## Applied

| Item | Change |
|------|--------|
| pnpm workspaces | Added `pnpm-workspace.yaml`; silences pnpm workspace warnings |
| Test duplication | `vitest.config.ts` runs only `tests/**/*.test.ts`; `tsconfig` excludes `dist/` |
| Typecheck stability | `compilerOptions.types: ["node"]` avoids broken implicit `@types/*` from partial npm installs |
| Install reliability | `.npmrc` points to `registry.npmjs.org` |
| Lockfile | Track `pnpm-lock.yaml` for reproducible installs |
| Agent/docs | `AGENTS.md` and README updated for pnpm-first workflow |
| CI | GitHub Actions: install → lint → test → build |

## Follow-up (not in this PR)

- Split `tsconfig.build.json` vs `tsconfig.json` if apps need separate compile graphs
- Wire Prisma/Postgres when persistence moves beyond in-memory MVP stores
- `pnpm approve-builds` for esbuild if native bindings are required in CI
