import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { resolveEngagementScopedData } from '../../shared/src/index.js';

export const DEFAULT_CONSOLE_CDP_PORT = 9222;
export const CAPTURE_EVIDENCE_ROOT_ENV_VAR = 'SANGFOR_EVIDENCE_ROOT';

export function formatDateStamp(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

export function normalizeCaptureSegment(raw: string): string {
  let value = String(raw ?? '').trim();
  value = value.replace(/[^A-Za-z0-9._-]/g, '_');
  value = value.replace(/\.{2,}/g, '_');
  value = value.replace(/_{2,}/g, '_');
  value = value.replace(/^[_.]+|[_.]+$/g, '');
  return value || 'unnamed';
}

export function buildCaptureFilePath(
  outputDir: string,
  reqId: string,
  product: string,
  menuLabel: string,
  dateStamp: string,
): string {
  const fileName = `REQ${normalizeCaptureSegment(reqId)}_${normalizeCaptureSegment(product)}_${normalizeCaptureSegment(menuLabel)}_Before_${normalizeCaptureSegment(dateStamp)}.png`;
  return join(outputDir, fileName);
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function isConfinedDescendant(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel.length > 0
    && !rel.startsWith(`..${sep}`)
    && rel !== '..'
    && !isAbsolute(rel);
}

export function resolveConfinedOutputDir(requestedOutputDir: string): string {
  const root = resolveEngagementScopedData(
    'data/evidence',
    CAPTURE_EVIDENCE_ROOT_ENV_VAR,
  );
  mkdirSync(root, { recursive: true });
  const rootReal = realpathSync(root);
  const outsideError = () => new Error(
    `CAPTURE_DIR_OUTSIDE_ROOT: ${requestedOutputDir} is outside ${rootReal}`,
  );
  const requestedAbs = resolve(rootReal, requestedOutputDir);
  if (
    requestedAbs !== rootReal
    && !isConfinedDescendant(rootReal, requestedAbs)
  ) throw outsideError();

  let current = rootReal;
  const relPath = relative(rootReal, requestedAbs);
  if (relPath !== '') {
    for (const segment of relPath.split(sep).filter(Boolean)) {
      const next = join(current, segment);
      let lex: Stats | null;
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
  const outReal = realpathSync(current);
  if (
    outReal !== rootReal
    && !isConfinedDescendant(rootReal, outReal)
  ) throw outsideError();
  return outReal;
}
