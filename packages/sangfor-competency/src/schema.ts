/**
 * WorkAtom wire schema — the single trust boundary for the competency catalog.
 *
 * Everything on disk is untrusted. It is parsed here exactly once into typed
 * values; nothing downstream re-validates or re-narrows. Strict objects mean an
 * unknown key is a defect, not a field we quietly ignore: a typo'd `evidance`
 * must fail the catalog rather than silently drop the citation and inflate the
 * replacement rate.
 */
import { z } from 'zod';

export const LIFECYCLE_PHASES = ['discover', 'design', 'validate', 'deploy', 'operate', 'handover', 'incident'] as const;
export const AUTOMATABILITIES = ['auto', 'hybrid', 'human'] as const;
export const MATURITIES = ['planned', 'implemented_local', 'tested_mock', 'field_verified'] as const;

export type LifecyclePhase = (typeof LIFECYCLE_PHASES)[number];
export type Automatability = (typeof AUTOMATABILITIES)[number];
export type Maturity = (typeof MATURITIES)[number];

/** Ordered ladder: a policy entry below an atom's claim is an over-claim. */
export const MATURITY_RANK: Readonly<Record<Maturity, number>> = {
  planned: 0,
  implemented_local: 1,
  tested_mock: 2,
  field_verified: 3,
};

const nonBlank = z.string().trim().min(1);

export const capabilityRefSchema = z.object({
  product: nonBlank,
  capabilityId: nonBlank,
}).strict().readonly();

export const workAtomSchema = z.object({
  id: nonBlank,
  product: nonBlank,
  phase: z.enum(LIFECYCLE_PHASES),
  title: nonBlank,
  automatability: z.enum(AUTOMATABILITIES),
  humanReason: nonBlank.optional(),
  coveredBy: nonBlank.nullish(),
  maturity: z.enum(MATURITIES),
  evidence: nonBlank.nullish(),
  capabilityRef: capabilityRefSchema.optional(),
}).strict().readonly();

/**
 * A catalog file is either a bare atom array or `{ atoms: [...] }`. The wrapper
 * is closed: a stray `generatedBy` or a misspelled `atom` key means the file is
 * not the shape we think it is, and a catalog we cannot fully account for is not
 * a denominator.
 */
export const workAtomFileSchema = z.union([
  z.array(workAtomSchema).readonly(),
  z.object({ version: z.number().int().optional(), atoms: z.array(workAtomSchema).readonly() }).strict().readonly(),
]);

/**
 * `evidence` is part of the committed policy format (each entry cites what
 * justified its maturity), so it is modelled rather than tolerated — that is what
 * lets the entry be `.strict()` without touching curated data.
 */
export const maturityPolicyEntrySchema = z.object({
  product: nonBlank,
  capabilityId: nonBlank,
  maturity: z.enum(MATURITIES),
  evidence: nonBlank.optional(),
}).strict().readonly();

/**
 * `entries` must be non-empty: a policy that declares nothing is
 * indistinguishable from no policy at all, and it silently disables the maturity
 * cross-check for every claim instead of contradicting any of them.
 */
export const maturityPolicyFileSchema = z.object({
  version: z.number().int().optional(),
  entries: z.array(maturityPolicyEntrySchema).min(1).readonly(),
}).strict().readonly();

export type WorkAtom = z.infer<typeof workAtomSchema>;
export type WorkAtomFile = z.infer<typeof workAtomFileSchema>;
export type CapabilityRef = z.infer<typeof capabilityRefSchema>;
export type MaturityPolicyEntry = z.infer<typeof maturityPolicyEntrySchema>;
export type MaturityPolicyFile = z.infer<typeof maturityPolicyFileSchema>;

/** Ids collide when they normalize alike — case and padding must not mint a second atom. */
export const normalizeAtomId = (id: string): string => id.trim().toLowerCase();

export const capabilityKey = (ref: CapabilityRef): string => `${ref.product}::${ref.capabilityId}`;
