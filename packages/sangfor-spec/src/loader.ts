/** Spec loading from disk: merge every spec JSON for a product/version, and
 *  enumerate which product/version pairs have specs at all. */

import { readdirSync, readFileSync } from 'node:fs';
import { resolveRepoData } from '../../shared/src/index.js';
import { normalizeSpecProduct, specDirectoryCandidates } from './product.js';
import { parseBoundaryIntendedSpecV1 } from './runtime-boundaries.js';
import {
  isSafeSpecPathSegment,
  isSafeSpecProductInput,
  listConfinedSpecFiles,
  resolveConfinedDirectory,
  resolveSpecRoot,
} from './spec-paths.js';
import type { IntendedSpec, SpecItem } from './types.js';

const specRoot = () => resolveRepoData('data/specs', 'SANGFOR_SPEC_ROOT');

/** Load and merge all spec JSON files for a product/version, or null if none. */
export function loadSpec(product: string, version: string, root: string = specRoot()): IntendedSpec | null {
  if (!isSafeSpecProductInput(product) || typeof version !== 'string' || !isSafeSpecPathSegment(version)) return null;
  const rootReal = resolveSpecRoot(root);
  if (!rootReal) return null;
  const productDir = specDirectoryCandidates(product)
    .map((candidate) => resolveConfinedDirectory(rootReal, candidate))
    .find((candidate): candidate is string => candidate !== null);
  if (!productDir) return null;
  const dir = resolveConfinedDirectory(productDir, version);
  if (!dir) return null;
  const files = listConfinedSpecFiles(dir);
  if (files.length === 0) return null;
  const items: SpecItem[] = [];
  let product0 = normalizeSpecProduct(product);
  for (const file of files) {
    let parsed: IntendedSpec;
    try {
      parsed = parseBoundaryIntendedSpecV1(readFileSync(file.path, 'utf8'));
    } catch {
      // A single corrupt spec file must not crash the whole product's advisory, nor
      // vanish silently. Surface it as a MUST-without-source sentinel → evaluates to
      // INDETERMINATE (senior review) instead of a false clean bill of health.
      items.push({
        id: `_unparseable_${file.name}`.replace(/[^\w]/g, '_'),
        capabilityId: '_load_error',
        label: `스펙 파일 파싱 실패: ${file.name} — 시니어 검토 필요 (unparseable spec file)`,
        observedKey: '_unparseable',
        op: 'exists',
        severity: 'must',
      });
      continue;
    }
    if (parsed.product) product0 = normalizeSpecProduct(parsed.product);
    items.push(...(parsed.items ?? []));
  }
  return { id: `spec_${normalizeSpecProduct(product)}_${version}`.replace(/[^\w]/g, '_'), product: product0, version, items };
}

/** List all product/version pairs that have specs on disk. */
export function listSpecCoverage(root: string = specRoot()): Array<{ product: string; version: string; items: number }> {
  const out: Array<{ product: string; version: string; items: number }> = [];
  const rootReal = resolveSpecRoot(root);
  if (!rootReal) return out;
  for (const product of readdirSync(rootReal)) {
    const pDir = resolveConfinedDirectory(rootReal, product);
    if (!pDir) continue;
    for (const version of readdirSync(pDir)) {
      if (!resolveConfinedDirectory(pDir, version)) continue;
      const spec = loadSpec(product, version, rootReal);
      if (spec) out.push({ product, version, items: spec.items.length });
    }
  }
  return out;
}
