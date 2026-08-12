#!/usr/bin/env node
/**
 * BLRO data scope boundary gate.
 *
 * Scope in this repo is currently FAIL-OPEN: `resolveRepoData(...)` returns the
 * shared root when `SANGFOR_ENGAGEMENT_ID` is unset, so a module that forgets
 * the scoped resolver does not crash — it quietly writes into the partition of
 * whichever project is active. That is exactly the failure this gate removes:
 * for a data root that IS project-scoped, resolving it unscoped is a build
 * failure, not a silent divergence.
 *
 * Scope key note (Phase 3 / D1): `engagementId` is the seed of `projectId`.
 * When the identity model lands, the scoped resolver becomes project-scoped and
 * this gate keeps its meaning unchanged.
 *
 *   node scripts/check-data-scope-boundary.mjs
 *   node scripts/check-data-scope-boundary.mjs --self-test   # prove it can fail
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import process from 'node:process';

const root = process.cwd();

/**
 * Data roots that carry per-project material. Writing one of these unscoped
 * mixes customer material across projects.
 */
const SCOPED_ROOTS = ['data/runs', 'data/evidence', 'data/feedback'];

/** Trees whose modules must honour the scoped resolver. */
const TARGETS = ['packages', 'apps/mcp-server/src', 'apps/control-tower/src', 'apps/operator-console/src'];

/**
 * Files exempt with a stated reason. `shared` DEFINES both resolvers, and the
 * scope gate itself must be able to name the unscoped helper.
 */
const EXEMPT = new Map([
  ['packages/shared/src/index.ts', 'defines resolveRepoData and resolveEngagementScopedData'],
]);

const UNSCOPED_CALL = /resolveRepoData\s*\(\s*['"]([^'"]+)['"]/g;

function sourceFilesUnder(dir) {
  const absolute = join(root, dir);
  let entries;
  try {
    entries = readdirSync(absolute, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const child = join(absolute, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') return [];
      return sourceFilesUnder(relative(root, child));
    }
    if (!statSync(child).isFile()) return [];
    return /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name) ? [child] : [];
  });
}

/** Every unscoped resolution of a scoped root, as `path: root` violations. */
export function findScopeViolations(files) {
  const violations = [];
  for (const absolute of files) {
    const path = relative(root, absolute);
    if (EXEMPT.has(path)) continue;
    const source = readFileSync(absolute, 'utf8');
    for (const match of source.matchAll(UNSCOPED_CALL)) {
      const requested = match[1];
      const scoped = SCOPED_ROOTS.find(
        (candidate) => requested === candidate || requested.startsWith(`${candidate}/`),
      );
      if (scoped) {
        violations.push(`${path}: resolves scoped root "${requested}" through resolveRepoData`);
      }
    }
  }
  return violations;
}

if (process.argv.includes('--self-test')) {
  // Prove the detector can fail: run it against a synthetic source that commits
  // the exact mistake. A gate that has never been observed failing is not a gate.
  const probe = `const dir = resolveRepoData('data/evidence', 'SANGFOR_EVIDENCE_ROOT');`;
  const detected = [...probe.matchAll(UNSCOPED_CALL)].some(([, requested]) =>
    SCOPED_ROOTS.some((candidate) => requested === candidate || requested.startsWith(`${candidate}/`)),
  );
  if (!detected) {
    process.stderr.write('SELF_TEST_FAILED: detector did not flag a known-bad probe\n');
    process.exitCode = 1;
  } else {
    process.stdout.write('SELF_TEST_DETECTED_VIOLATION\n');
  }
} else {
  const violations = findScopeViolations(TARGETS.flatMap(sourceFilesUnder));
  if (violations.length > 0) {
    process.stderr.write(`${violations.join('\n')}\n`);
    process.stderr.write(
      `\n${violations.length} scoped-root violation(s): use resolveEngagementScopedData for ${SCOPED_ROOTS.join(', ')}.\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write('BLRO_DATA_SCOPE_BOUNDARY_PASS\n');
  }
}
