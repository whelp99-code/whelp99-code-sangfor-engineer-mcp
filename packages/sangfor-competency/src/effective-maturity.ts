import { RuntimeSchemaError } from '../../shared/src/runtime-schema.js';
import type { CoverageContext } from './context.js';
import { auditClaimGrounding, buildReplacementReport, type ReplacementReport } from './coverage.js';
import {
  evaluateEffectiveClaim,
  type EffectiveClaimIssue,
  type EffectiveEvidenceClaim,
  type EffectiveParsedClaim,
} from './effective-claim.js';
import {
  CapabilityEvidenceGroundingError,
  parseGroundedCapabilityEvidence,
  type CapabilityEvidenceGrounding,
} from './evidence-grounding.js';
import { loadWorkAtomCatalog } from './loader.js';
import type { PromotionLedger, PromotionLedgerEvent } from './promotion-ledger.js';
import { violation, type CoverageViolation } from './violations.js';

export type EffectiveMaturityAuthority = {
  readonly claims: readonly EffectiveEvidenceClaim[];
  readonly ledger: PromotionLedger;
};

export type EffectiveReplacementReport = ReplacementReport & {
  readonly claimIssues: readonly EffectiveClaimIssue[];
};

export type EffectiveCoverageResult =
  | { readonly ok: true; readonly report: EffectiveReplacementReport }
  | { readonly ok: false; readonly violations: readonly CoverageViolation[] };

function parseClaims(
  claims: readonly EffectiveEvidenceClaim[],
  grounding: CapabilityEvidenceGrounding,
): { readonly parsed: readonly EffectiveParsedClaim[]; readonly violations: readonly CoverageViolation[] } {
  const parsed: EffectiveParsedClaim[] = [];
  const violations: CoverageViolation[] = [];
  for (const source of claims) {
    try {
      parsed.push({ source, manifest: parseGroundedCapabilityEvidence({ source: source.manifestSource, grounding }) });
    } catch (error) {
      if (!(error instanceof CapabilityEvidenceGroundingError) && !(error instanceof RuntimeSchemaError)) throw error;
      violations.push(violation('activeEvidenceUnavailable', null, error.message));
    }
  }
  return { parsed, violations };
}

export async function computeEffectiveReplacementCoverage(
  context: CoverageContext,
  authority?: EffectiveMaturityAuthority,
): Promise<EffectiveCoverageResult> {
  const loaded = loadWorkAtomCatalog(context.catalogRoot);
  if (!loaded.ok) return loaded;

  const fieldClaims = loaded.atoms.filter((atom) => atom.automatability !== 'human' && atom.maturity === 'field_verified');
  if (fieldClaims.length === 0) {
    return { ok: true, report: { ...buildReplacementReport(loaded.atoms, new Set()), claimIssues: [] } };
  }
  if (authority === undefined) {
    return { ok: false, violations: [
      violation('activeEvidenceUnavailable', null, 'automatable field_verified claims require current evidence'),
      violation('promotionLedgerUnavailable', null, 'automatable field_verified claims require authenticated promotion state'),
    ] };
  }

  let events: readonly PromotionLedgerEvent[];
  try {
    events = await authority.ledger.read();
  } catch {
    return { ok: false, violations: [violation('promotionLedgerUnavailable', null, 'authenticated ledger or checkpoint is unavailable')] };
  }

  const structuralViolations = fieldClaims.flatMap((atom) => auditClaimGrounding(atom, context));
  if (structuralViolations.length > 0) return { ok: false, violations: structuralViolations };
  const grounding = { atoms: loaded.atoms, context } satisfies CapabilityEvidenceGrounding;
  const claims = parseClaims(authority.claims, grounding);
  const claimsByAtom = new Map<string, EffectiveParsedClaim[]>();
  for (const claim of claims.parsed) {
    for (const atomId of claim.manifest.target.workAtomIds) {
      const matches = claimsByAtom.get(atomId) ?? [];
      matches.push(claim);
      claimsByAtom.set(atomId, matches);
    }
  }

  const violations: CoverageViolation[] = [...claims.violations];
  for (const atom of fieldClaims) {
    const matches = claimsByAtom.get(atom.id) ?? [];
    if (matches.length === 0) violations.push(violation('activeEvidenceUnavailable', atom.id, 'field_verified claim has no current grounded evidence manifest'));
    if (matches.length > 1) violations.push(violation('duplicateEvidenceClaim', atom.id, 'field_verified claim has conflicting current evidence manifests'));
  }
  if (violations.length > 0) return { ok: false, violations };

  const replacedAtomIds = new Set<string>();
  const claimIssues: EffectiveClaimIssue[] = [];
  for (const atom of fieldClaims) {
    const claim = claimsByAtom.get(atom.id)?.[0];
    if (claim === undefined || atom.capabilityRef === undefined) continue;
    const baseline = context.maturityByCapability.get(`${atom.capabilityRef.product}::${atom.capabilityRef.capabilityId}`);
    if (baseline === undefined) continue;
    const evaluated = await evaluateEffectiveClaim({ claim, atom, baseline, events, ledger: authority.ledger });
    if (evaluated.violations.length > 0) return { ok: false, violations: evaluated.violations };
    if (evaluated.replaced) replacedAtomIds.add(atom.id);
    if (evaluated.issue !== undefined) claimIssues.push(evaluated.issue);
  }
  return { ok: true, report: { ...buildReplacementReport(loaded.atoms, replacedAtomIds), claimIssues } };
}

export type { EffectiveClaimIssue, EffectiveEvidenceClaim } from './effective-claim.js';
