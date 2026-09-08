import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { WorkAtom } from './schema.js';
import { violation, type CoverageViolation } from './violations.js';

export const WORK_ATOM_CATALOG_MANIFEST_FILE = 'catalog-manifest.json' as const;
export const WORK_ATOM_CATALOG_MANIFEST_VERSION = 1 as const;

const catalogManifestSchema = z.object({
  version: z.literal(WORK_ATOM_CATALOG_MANIFEST_VERSION),
  semanticSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  atomIds: z.array(z.string().trim().min(1)).readonly(),
  counts: z.object({
    atoms: z.number().int().nonnegative(),
    automatable: z.number().int().nonnegative(),
    human: z.number().int().nonnegative(),
  }).strict().readonly(),
}).strict().readonly();

export type WorkAtomCatalogManifest = z.infer<typeof catalogManifestSchema>;

class CatalogCanonicalizationError extends Error {
  readonly name = 'CatalogCanonicalizationError';
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value !== 'object') throw new CatalogCanonicalizationError('catalog value is not canonicalizable');
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
}

export function deriveWorkAtomCatalogManifest(atoms: readonly WorkAtom[]): WorkAtomCatalogManifest {
  const sorted = [...atoms].sort(({ id: left }, { id: right }) => left.localeCompare(right));
  return catalogManifestSchema.parse({
    version: WORK_ATOM_CATALOG_MANIFEST_VERSION,
    semanticSha256: createHash('sha256')
      .update(`sangfor.work-atom-catalog.v1\n${canonical(sorted)}`, 'utf8')
      .digest('hex'),
    atomIds: sorted.map(({ id }) => id),
    counts: {
      atoms: sorted.length,
      automatable: sorted.filter(({ automatability }) => automatability !== 'human').length,
      human: sorted.filter(({ automatability }) => automatability === 'human').length,
    },
  });
}

export function readAndVerifyCatalogManifest(
  root: string,
  atoms: readonly WorkAtom[],
): { readonly ok: true; readonly manifest: WorkAtomCatalogManifest }
  | { readonly ok: false; readonly violations: readonly CoverageViolation[] } {
  let source: string;
  try {
    source = readFileSync(join(root, WORK_ATOM_CATALOG_MANIFEST_FILE), 'utf8');
  } catch {
    return { ok: false, violations: [violation('catalogManifestInvalid', null, 'canonical catalog manifest is missing or unreadable')] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return { ok: false, violations: [violation('catalogManifestInvalid', null, 'canonical catalog manifest is malformed')] };
  }
  const parsed = catalogManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, violations: [violation('catalogManifestInvalid', null, 'canonical catalog manifest schema is invalid')] };
  }
  const expected = deriveWorkAtomCatalogManifest(atoms);
  if (canonical(parsed.data) !== canonical(expected)) {
    return { ok: false, violations: [violation('catalogManifestInvalid', null, 'canonical catalog semantic binding does not match loaded atoms')] };
  }
  return { ok: true, manifest: parsed.data };
}
