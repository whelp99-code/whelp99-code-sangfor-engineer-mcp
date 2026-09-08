import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function findRepoRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 16; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const unanchoredWarned = new Set<string>();

/** Resolve a repo data directory relative to the code, with an optional env override. */
export function resolveRepoData(subdir: string, envVar?: string): string {
  const override = envVar ? process.env[envVar] : undefined;
  if (override) return override;
  const root = findRepoRoot();
  if (!root) {
    if (!unanchoredWarned.has(subdir)) {
      unanchoredWarned.add(subdir);
      process.stderr.write(`[data-root] could not anchor '${subdir}' (no pnpm-workspace.yaml found) — set ${envVar ?? 'SANGFOR_*_ROOT'} to avoid silent-empty data\n`);
    }
    return subdir;
  }
  return join(root, subdir);
}

const ENGAGEMENT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/u;

export function activeEngagementId(): string | undefined {
  const raw = process.env.SANGFOR_ENGAGEMENT_ID?.trim();
  if (!raw) return undefined;
  if (raw === '.' || raw.includes('..') || !ENGAGEMENT_ID_RE.test(raw)) {
    throw new Error(
      `Invalid SANGFOR_ENGAGEMENT_ID "${raw}": must match ${ENGAGEMENT_ID_RE.source} and must not be '.' or contain '..'.`,
    );
  }
  return raw;
}

export function resolveEngagementScopedData(subdir: string, envVar?: string): string {
  const base = resolveRepoData(subdir, envVar);
  const engagementId = activeEngagementId();
  return engagementId ? join(base, engagementId) : base;
}
