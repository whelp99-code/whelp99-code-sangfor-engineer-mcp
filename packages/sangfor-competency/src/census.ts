import { z } from 'zod';
import {
  assertCanonicalCatalogAuthority,
  type CanonicalWorkAtomCatalog,
} from './loader.js';
import type { CoverageContext } from './context.js';
import { MATURITIES } from './schema.js';

export const CENSUS_CLAIM_STATES = ['active', 'stale', 'unverified', 'conflicting'] as const;
export type CensusClaimState = (typeof CENSUS_CLAIM_STATES)[number];

const censusAtomStructuralSchema = z.object({
  atomId: z.string().trim().min(1),
  product: z.string().trim().min(1),
  phase: z.string().trim().min(1),
  automatability: z.enum(['auto', 'hybrid', 'human']),
  capabilityRef: z.object({ product: z.string().min(1), capabilityId: z.string().min(1) }).strict().readonly().nullable(),
  toolRef: z.string().trim().min(1).nullable(),
  claim: z.object({ state: z.enum(CENSUS_CLAIM_STATES), maturity: z.enum(MATURITIES) }).strict().readonly(),
  requiredEvidence: z.object({
    required: z.literal(true),
    path: z.string().trim().min(1).nullable(),
    o5Status: z.enum(['NOT_RUN', 'HUMAN_ONLY']),
  }).strict().readonly(),
}).strict().readonly();

const blockedPrerequisiteStructuralSchema = z.object({
  product: z.enum(['HCI', 'IAG', 'EPP', 'CC']),
  status: z.literal('BLOCKED'),
  prerequisites: z.array(z.string().trim().min(1)).min(1).readonly(),
}).strict().readonly();

const productEvidenceCensusStructuralSchema = z.object({
  version: z.literal(1),
  catalog: z.object({
    immutable: z.literal(true),
    authority: z.literal('canonical_work_atom_catalog'),
    catalogHash: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict().readonly(),
  totals: z.object({ atoms: z.number().int().nonnegative(), automatable: z.number().int().nonnegative(), humanOnly: z.number().int().nonnegative() }).strict().readonly(),
  claimSummary: z.object({
    active: z.number().int().nonnegative(), stale: z.number().int().nonnegative(),
    unverified: z.number().int().nonnegative(), conflicting: z.number().int().nonnegative(),
  }).strict().readonly(),
  atoms: z.array(censusAtomStructuralSchema).readonly(),
  blockedPrerequisites: z.array(blockedPrerequisiteStructuralSchema).length(4).readonly(),
  authority: z.object({ status: z.literal('invalid'), violations: z.array(z.string().min(1)).min(1).readonly() }).strict().readonly(),
}).strict().readonly();

export type ProductEvidenceCensus = z.infer<typeof productEvidenceCensusStructuralSchema>;
export type ProductEvidenceCensusAtom = z.infer<typeof censusAtomStructuralSchema>;
export type ProductBlockedPrerequisite = z.infer<typeof blockedPrerequisiteStructuralSchema>;

export class CensusAuthorityError extends Error {
  readonly name = 'CensusAuthorityError';

  constructor(readonly code: 'census_semantic_mismatch') {
    super(`CAPABILITY_CENSUS_AUTHORITY_REFUSED: ${code}`);
  }
}

const BLOCKED: readonly ProductBlockedPrerequisite[] = [
  { product: 'HCI', status: 'BLOCKED', prerequisites: ['lab cluster', 'device and firmware identity', 'execution window', 'human approval'] },
  { product: 'IAG', status: 'BLOCKED', prerequisites: ['lab appliance', 'isolated authentication source', 'execution window', 'human approval'] },
  { product: 'EPP', status: 'BLOCKED', prerequisites: ['lab manager', 'disposable endpoint cohort', 'execution window', 'human approval'] },
  { product: 'CC', status: 'BLOCKED', prerequisites: ['lab tenant', 'isolated event sources', 'execution window', 'human approval'] },
] as const;

class CensusCanonicalizationError extends Error {
  readonly name = 'CensusCanonicalizationError';
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value !== 'object') throw new CensusCanonicalizationError('census value is not canonicalizable');
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
}

export function buildProductEvidenceCensus(
  catalog: CanonicalWorkAtomCatalog,
  context: CoverageContext,
): ProductEvidenceCensus {
  assertCanonicalCatalogAuthority(catalog);
  const authorityViolations = catalog.atoms.flatMap((atom) => {
    if (atom.maturity !== 'field_verified' || atom.automatability === 'human') return [];
    const issues: string[] = [];
    if (atom.capabilityRef === undefined) issues.push(`${atom.id}: capabilityRef missing`);
    if (atom.coveredBy === null || atom.coveredBy === undefined || !context.registeredTools.has(atom.coveredBy)) {
      issues.push(`${atom.id}: registered tool authority missing`);
    }
    if (atom.evidence === null || atom.evidence === undefined) issues.push(`${atom.id}: evidence path missing`);
    return issues;
  });
  return productEvidenceCensusStructuralSchema.parse({
    version: 1,
    catalog: { immutable: true, authority: 'canonical_work_atom_catalog', catalogHash: catalog.manifest.semanticSha256 },
    totals: {
      atoms: catalog.manifest.counts.atoms,
      automatable: catalog.manifest.counts.automatable,
      humanOnly: catalog.manifest.counts.human,
    },
    claimSummary: { active: 0, stale: 0, unverified: catalog.manifest.counts.atoms, conflicting: 0 },
    atoms: catalog.atoms.map((atom) => ({
      atomId: atom.id,
      product: atom.product,
      phase: atom.phase,
      automatability: atom.automatability,
      capabilityRef: atom.capabilityRef ?? null,
      toolRef: atom.coveredBy ?? null,
      claim: { state: 'unverified', maturity: atom.maturity },
      requiredEvidence: {
        required: true,
        path: atom.evidence ?? null,
        o5Status: atom.automatability === 'human' ? 'HUMAN_ONLY' : 'NOT_RUN',
      },
    })),
    blockedPrerequisites: BLOCKED,
    authority: {
      status: 'invalid',
      violations: authorityViolations.length > 0 ? authorityViolations : ['active evidence authority is not configured'],
    },
  });
}

export function verifyProductEvidenceCensus(
  census: ProductEvidenceCensus,
  authority: { readonly catalog: CanonicalWorkAtomCatalog; readonly context: CoverageContext },
): ProductEvidenceCensus {
  assertCanonicalCatalogAuthority(authority.catalog);
  const expected = buildProductEvidenceCensus(authority.catalog, authority.context);
  if (canonical(census) !== canonical(expected)) throw new CensusAuthorityError('census_semantic_mismatch');
  return census;
}

export function parseProductEvidenceCensus(
  value: unknown,
  authority: { readonly catalog: CanonicalWorkAtomCatalog; readonly context: CoverageContext },
): ProductEvidenceCensus {
  assertCanonicalCatalogAuthority(authority.catalog);
  return verifyProductEvidenceCensus(productEvidenceCensusStructuralSchema.parse(value), authority);
}
