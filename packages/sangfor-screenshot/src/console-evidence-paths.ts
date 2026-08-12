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

/**
 * A device identifier reduced to ONE safe path/filename token, or undefined
 * when no device was supplied.
 *
 * Blank input returns undefined rather than the `unnamed` placeholder that
 * normalizeCaptureSegment produces: a capture with no known device must look
 * exactly like it did before this dimension existed, not like it belongs to a
 * device literally called "unnamed".
 */
export function normalizeDeviceSegment(raw: string | undefined): string | undefined {
  if (raw === undefined || String(raw).trim() === '') return undefined;
  const normalized = normalizeCaptureSegment(raw);
  return normalized === 'unnamed' ? undefined : normalized;
}

/**
 * Evidence is separated by customer / device / date:
 *   <engagement-scoped evidence root>/captures/<YYYYMMDD>/<device>/
 *
 * The customer dimension comes from the engagement-scoped root and the date is
 * this folder; the device segment is appended here. Omitting the device yields
 * the pre-existing `captures/<YYYYMMDD>` path so captures already on disk stay
 * findable and older callers keep working.
 */
export function buildCaptureRelativeDir(dateStamp: string, deviceId?: string): string {
  const base = join('captures', normalizeCaptureSegment(dateStamp));
  const device = normalizeDeviceSegment(deviceId);
  return device ? join(base, device) : base;
}

export function buildCaptureFilePath(
  outputDir: string,
  reqId: string,
  product: string,
  menuLabel: string,
  dateStamp: string,
  deviceId?: string,
): string {
  // The device token sits next to the product so the filename stays
  // self-describing when a single image is copied out of its folder into a
  // customer report.
  const device = normalizeDeviceSegment(deviceId);
  const devicePart = device ? `${device}_` : '';
  const fileName = `REQ${normalizeCaptureSegment(reqId)}_${normalizeCaptureSegment(product)}_${devicePart}${normalizeCaptureSegment(menuLabel)}_Before_${normalizeCaptureSegment(dateStamp)}.png`;
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
