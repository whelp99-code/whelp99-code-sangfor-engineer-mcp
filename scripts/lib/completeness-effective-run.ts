import {
  computeEffectiveReplacementCoverage,
  loadEffectiveMaturityAuthority,
  type CoverageContext,
  type EffectiveAuthoritySource,
  type EffectiveCoverageResult,
  type EffectiveEvidenceClaimSource,
} from '../../packages/sangfor-competency/src/index.js';
import { resolveProductionLocalWriteAuthority } from '../../packages/shared/src/index.js';
import { dirname } from 'node:path';

export type EffectiveCliSource = {
  readonly evidenceRoot: string;
  readonly evidenceManifests: readonly string[];
  readonly validationContexts: readonly string[];
  readonly promotionLedger: string;
  readonly ledgerSecret: string | undefined;
  readonly checkpointSecret: string | undefined;
};

function authoritySource(source: EffectiveCliSource): EffectiveAuthoritySource {
  /** Boundary accumulator pairing repeated manifest/context flags by position. */
  const claims: EffectiveEvidenceClaimSource[] = [];
  for (const [index, manifestPath] of source.evidenceManifests.entries()) {
    const validationContextPath = source.validationContexts[index];
    if (validationContextPath === undefined) continue;
    claims.push({ manifestPath, validationContextPath, evidenceRoot: source.evidenceRoot });
  }
  return {
    claims,
    ledgerPath: source.promotionLedger.length === 0 ? undefined : source.promotionLedger,
    ledgerSecret: source.ledgerSecret,
    checkpointSecret: source.checkpointSecret,
    authority: resolveProductionLocalWriteAuthority({
      tenantId: process.env.SANGFOR_TENANT_ID ?? 'local-primary',
      projectId: process.env.SANGFOR_ENGAGEMENT_ID ?? 'local-primary', actorId: 'completeness-cli',
      aggregate: 'capability_evidence_promotion', sourceRoot: dirname(source.promotionLedger),
    }),
  };
}

export async function runEffectiveCoverage(
  context: CoverageContext,
  source: EffectiveCliSource,
): Promise<EffectiveCoverageResult> {
  const lowerOnly = await computeEffectiveReplacementCoverage(context);
  if (lowerOnly.ok) return lowerOnly;
  const authority = loadEffectiveMaturityAuthority(authoritySource(source));
  if (!authority.ok) return authority;
  return computeEffectiveReplacementCoverage(context, authority.authority);
}
