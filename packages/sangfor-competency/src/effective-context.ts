import { lstatSync, readFileSync } from 'node:fs';
import { parseEvidenceValidationContext } from './evidence-validation-context.js';
import type { EffectiveEvidenceClaim, EffectiveMaturityAuthority } from './effective-maturity.js';
import { FilePromotionLedger, PromotionLedgerUnavailableError } from './promotion-ledger.js';
import { violation, type CoverageViolation } from './violations.js';

export type EffectiveEvidenceClaimSource = {
  readonly manifestPath: string;
  readonly validationContextPath: string;
  readonly evidenceRoot: string;
};

export type EffectiveAuthoritySource = {
  readonly claims: readonly EffectiveEvidenceClaimSource[];
  readonly ledgerPath: string | undefined;
  readonly ledgerSecret: string | undefined;
  readonly checkpointSecret: string | undefined;
};

export type EffectiveAuthorityLoad =
  | { readonly ok: true; readonly authority: EffectiveMaturityAuthority }
  | { readonly ok: false; readonly violations: readonly CoverageViolation[] };

function readRegularFile(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new PromotionLedgerUnavailableError();
  return readFileSync(path, 'utf8');
}

function loadClaims(sources: readonly EffectiveEvidenceClaimSource[]): readonly EffectiveEvidenceClaim[] {
  return sources.map((source) => ({
    manifestSource: readRegularFile(source.manifestPath),
    evidenceRoot: source.evidenceRoot,
    context: parseEvidenceValidationContext(JSON.parse(readRegularFile(source.validationContextPath))),
  }));
}

export function loadEffectiveMaturityAuthority(source: EffectiveAuthoritySource): EffectiveAuthorityLoad {
  const violations: CoverageViolation[] = [];
  if (source.claims.length === 0) {
    violations.push(violation('activeEvidenceUnavailable', null, 'at least one current evidence manifest and validation context are required'));
  }
  if (source.ledgerPath === undefined || source.ledgerSecret === undefined || source.checkpointSecret === undefined) {
    violations.push(violation('promotionLedgerUnavailable', null, 'authenticated promotion ledger and checkpoint secrets are required'));
  }
  if (violations.length > 0) return { ok: false, violations };

  let claims: readonly EffectiveEvidenceClaim[];
  try {
    claims = loadClaims(source.claims);
  } catch (error) {
    return {
      ok: false,
      violations: [violation(
        'activeEvidenceUnavailable',
        null,
        `current evidence source is unreadable or invalid: ${error instanceof Error ? error.message : 'unknown failure'}`,
      )],
    };
  }

  const ledgerPath = source.ledgerPath;
  const ledgerSecret = source.ledgerSecret;
  const checkpointSecret = source.checkpointSecret;
  if (ledgerPath === undefined || ledgerSecret === undefined || checkpointSecret === undefined) {
    return { ok: false, violations };
  }
  try {
    return {
      ok: true,
      authority: {
        claims,
        ledger: FilePromotionLedger.open(ledgerPath, ledgerSecret, checkpointSecret),
      },
    };
  } catch (error) {
    if (!(error instanceof PromotionLedgerUnavailableError)) throw error;
    return {
      ok: false,
      violations: [violation('promotionLedgerUnavailable', null, 'authenticated promotion ledger or checkpoint is unavailable')],
    };
  }
}
