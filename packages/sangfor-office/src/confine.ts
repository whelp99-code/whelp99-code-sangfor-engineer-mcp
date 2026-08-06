/**
 * Write-target path confinement for @sangfor/office.
 *
 * Same realpath-per-segment confinement pattern as
 * packages/sangfor-screenshot/src/console-evidence.ts (resolveConfinedOutputDir),
 * adapted for a FILE path instead of a directory: the parent directory chain
 * is walked and created one segment at a time (never following a
 * pre-existing symlink anywhere in that chain), then the final file segment
 * itself is checked the same way. A pre-existing symlink at the final path
 * is rejected outright rather than followed, so this can't be used to write
 * through a symlink planted by a previous (possibly malicious) run.
 *
 * Unlike resolveConfinedOutputDir (which always roots at the fixed
 * engagement-scoped evidence dir), callers here may pass an explicit root —
 * that root is trusted directly (it is established by our own code, e.g. a
 * test's temp dir or another package's already-confined default), not
 * attacker-controlled MCP input. The default root, when no explicit root is
 * given, is the same (subdir, envVar) pair the capture-evidence tooling
 * uses, so every legitimate default output path already lands inside it.
 */
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { resolveEngagementScopedData } from '@sangfor/shared';

export const OFFICE_ROOT_ENV_VAR = 'SANGFOR_EVIDENCE_ROOT';

function isConfinedDescendant(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const rel = relative(root, candidate);
  return rel.length > 0 && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

function resolveOfficeRoot(explicitRoot?: string): string {
  if (explicitRoot) {
    mkdirSync(explicitRoot, { recursive: true });
    return realpathSync(explicitRoot);
  }
  const root = resolveEngagementScopedData('data/evidence', OFFICE_ROOT_ENV_VAR);
  mkdirSync(root, { recursive: true });
  return realpathSync(root);
}

/**
 * Resolves `requestedPath` to an absolute path confined under the allowed
 * root (default: the engagement-scoped data/evidence root; pass
 * explicitRoot to confine to a different, caller-established root instead).
 *
 * Throws `OFFICE_PATH_OUTSIDE_ROOT: <path> is outside <root>` if the
 * resolved path escapes the root via '..', an absolute path elsewhere, a
 * symlink planted in an intermediate directory, or IS the root itself
 * (a write target must be a file strictly under the root, not the root
 * directory).
 */
export function confineOfficePath(requestedPath: string, explicitRoot?: string): string {
  const rootReal = resolveOfficeRoot(explicitRoot);
  const outsideError = () => new Error(`OFFICE_PATH_OUTSIDE_ROOT: ${requestedPath} is outside ${rootReal}`);

  const requestedAbs = resolve(rootReal, requestedPath);
  if (requestedAbs === rootReal) throw outsideError();
  if (!isConfinedDescendant(rootReal, requestedAbs)) throw outsideError();

  // Walk + create the parent directory chain one segment at a time, from the
  // (already-real) root down. Any segment that already exists must be a real
  // directory — never a symlink — so a pre-planted symlink can't redirect
  // later segments (or the final file) outside the root.
  const parentDir = dirname(requestedAbs);
  const parentRel = relative(rootReal, parentDir);
  let current = rootReal;
  if (parentRel !== '' && parentRel !== '.') {
    for (const segment of parentRel.split(sep).filter(Boolean)) {
      const next = join(current, segment);
      let lex;
      try {
        lex = lstatSync(next);
      } catch {
        lex = null;
      }
      if (lex) {
        if (lex.isSymbolicLink() || !lex.isDirectory()) throw outsideError();
      } else {
        mkdirSync(next);
      }
      current = next;
    }
  }

  const parentReal = realpathSync(current);
  if (!isConfinedDescendant(rootReal, parentReal)) throw outsideError();

  const finalPath = join(parentReal, basename(requestedAbs));
  try {
    const finalLex = lstatSync(finalPath);
    if (finalLex.isSymbolicLink()) throw outsideError();
  } catch {
    /* doesn't exist yet — the common create/write case. */
  }

  return finalPath;
}
