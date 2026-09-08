/**
 * Filesystem confinement for spec sources. Every directory and file that the
 * loader touches must resolve — lexically AND after realpath — to a descendant
 * of the spec root, with symlinks rejected at each hop, so a crafted product or
 * version segment cannot read outside the spec tree.
 */

import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const MAX_SPEC_PATH_SEGMENT_LENGTH = 64;
const SAFE_SPEC_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;

export function isSafeSpecPathSegment(value: unknown): value is string {
  return typeof value === 'string'
    && value === value.trim()
    && value !== '.'
    && value !== '..'
    && [...value].length <= MAX_SPEC_PATH_SEGMENT_LENGTH
    && SAFE_SPEC_PATH_SEGMENT.test(value);
}

export function isSafeSpecProductInput(value: unknown): value is string {
  if (typeof value !== 'string' || value !== value.trim() || value.length === 0
    || [...value].length > MAX_SPEC_PATH_SEGMENT_LENGTH) return false;
  return /^[A-Za-z0-9 _+-]+$/u.test(value) || /^HCI\/SCP$/iu.test(value);
}

function isConfinedDescendant(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel.length > 0 && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

export function resolveSpecRoot(root: string): string | null {
  try {
    const absolute = resolve(root);
    const lexical = lstatSync(absolute);
    if (!lexical.isDirectory() || lexical.isSymbolicLink()) return null;
    const real = realpathSync(absolute);
    return lstatSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

export function resolveConfinedDirectory(parentReal: string, segment: string): string | null {
  if (!isSafeSpecPathSegment(segment)) return null;
  try {
    const lexical = resolve(parentReal, segment);
    if (!isConfinedDescendant(parentReal, lexical)) return null;
    const lexicalStat = lstatSync(lexical);
    if (!lexicalStat.isDirectory() || lexicalStat.isSymbolicLink()) return null;
    const real = realpathSync(lexical);
    if (!isConfinedDescendant(parentReal, real) || !lstatSync(real).isDirectory()) return null;
    return real;
  } catch {
    return null;
  }
}

export function listConfinedSpecFiles(directoryReal: string): Array<{ name: string; path: string }> {
  const out: Array<{ name: string; path: string }> = [];
  for (const entry of readdirSync(directoryReal, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || !entry.name.endsWith('.json') || !entry.isFile() || entry.isSymbolicLink()) continue;
    try {
      const lexical = resolve(directoryReal, entry.name);
      if (!isConfinedDescendant(directoryReal, lexical)) continue;
      const lexicalStat = lstatSync(lexical);
      if (!lexicalStat.isFile() || lexicalStat.isSymbolicLink()) continue;
      const real = realpathSync(lexical);
      if (!isConfinedDescendant(directoryReal, real) || !lstatSync(real).isFile()) continue;
      out.push({ name: entry.name, path: real });
    } catch {
      // A disappearing or unreadable entry is not an eligible spec source.
    }
  }
  return out;
}
