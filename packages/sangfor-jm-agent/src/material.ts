import { lstatSync, realpathSync } from 'node:fs';

export const MATERIAL_REFUSALS = {
  PATH_UNREADABLE: 'PATH_UNREADABLE',
  PATH_NOT_REGULAR_FILE: 'PATH_NOT_REGULAR_FILE',
  KEY_PERMISSIONS_WEAK: 'KEY_PERMISSIONS_WEAK',
} as const;

export type MaterialRefusal = (typeof MATERIAL_REFUSALS)[keyof typeof MATERIAL_REFUSALS];

export type MaterialCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: MaterialRefusal };

const KEY_PERMISSION_MASK = 0o077;

/**
 * A material path must be a real regular file reached without traversing a
 * symlink, so a swapped link cannot redirect trust material at startup.
 *
 * Certificate and key SEMANTICS live in server-identity.ts; this module only
 * judges the path itself, and deliberately imports no key API at all.
 */
export function checkMaterialPath(path: string, privateKey: boolean): MaterialCheck {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    return { ok: false, reason: MATERIAL_REFUSALS.PATH_UNREADABLE };
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    return { ok: false, reason: MATERIAL_REFUSALS.PATH_NOT_REGULAR_FILE };
  }
  try {
    if (realpathSync(path) !== path) {
      return { ok: false, reason: MATERIAL_REFUSALS.PATH_NOT_REGULAR_FILE };
    }
  } catch {
    return { ok: false, reason: MATERIAL_REFUSALS.PATH_UNREADABLE };
  }
  if (privateKey && (stats.mode & KEY_PERMISSION_MASK) !== 0) {
    return { ok: false, reason: MATERIAL_REFUSALS.KEY_PERMISSIONS_WEAK };
  }
  return { ok: true };
}
