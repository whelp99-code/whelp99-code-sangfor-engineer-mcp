import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { buildCoverageContext } from './context.js';
import { parseGroundedCapabilityEvidence } from './evidence-grounding.js';
import { validateAndPersistEvidenceStaleness } from './evidence-invalidation.js';
import { validateCapabilityEvidence } from './evidence-validation.js';
import { parseEvidenceValidationContext } from './evidence-validation-context.js';
import { nodeEvidenceFilesystem } from './evidence-filesystem.js';
import { MAX_CAPABILITY_EVIDENCE_BYTES } from './evidence-schema.js';
import { defaultCatalogRoot, loadWorkAtomCatalog } from './loader.js';
import { defaultPolicyRoot, loadMaturityPolicyStrict } from './policy.js';
import { FilePromotionLedger, maskedPromotionRef, samePromotionTarget } from './promotion-ledger.js';
import { deriveEffectiveMaturity } from './promotion-preflight.js';
import type { Maturity } from './schema.js';

export type WriteAuthorityReferences = {
  readonly manifestPath: string;
  readonly validationContextPath: string;
  readonly evidenceRoot: string;
  readonly ledgerPath: string;
};

export type ResolveWriteAuthorityInput = {
  readonly references: WriteAuthorityReferences;
  readonly persistence?: 'persist_staleness' | 'read_only';
  readonly expected: {
    readonly product: string;
    readonly capabilityId: string;
    readonly toolId: string;
    readonly mode: 'ordinary_field' | 'bootstrap_mock';
  };
};

/**
 * What an authorized resolution vouches for: the exact scope it was derived
 * from, plus the effective maturity replayed from the authenticated promotion
 * ledger. Downstream gates decide on `maturity`; no caller authors its own.
 */
export type AuthorizedWriteAuthority = {
  readonly scope: DerivedAuthorityScope;
  readonly maturity: Maturity;
};

export type ResolvedWriteAuthority =
  | ({ readonly status: 'ordinary_active' } & AuthorizedWriteAuthority)
  | ({ readonly status: 'bootstrap_candidate' } & AuthorizedWriteAuthority)
  | { readonly status: 'refused'; readonly code: string };

export type DerivedAuthorityScope = {
  readonly product: string;
  readonly capabilityId: string;
  readonly toolId: string;
  readonly targetEnvironment: 'lab' | 'production' | 'unclassified';
  readonly deviceId: string;
  readonly originDigest: string;
  readonly firmwareId: string;
  readonly firmwareTruth: {
    readonly recordId: string;
    readonly vendor: 'SANGFOR' | 'FORTINET' | 'CISCO';
    readonly adapterProduct: string;
    readonly productVariant: string | null;
    readonly versionRaw: string;
    readonly versionFamily: string;
    readonly revision: string | null;
    readonly buildId: string | null;
    readonly hotfix: string | null;
    readonly uiFingerprint: string | null;
    readonly apiFingerprint: string | null;
    readonly status: 'verified';
    readonly observedAt: string;
    readonly specVersion: string;
    readonly specApplicability: 'verified';
    readonly truthDigest: string;
  };
  readonly implementation: {
    readonly recipeDigest: string;
    readonly toolDigest: string;
    readonly runtimeDigest: string;
  };
  readonly windowId: string;
  readonly sessionId: string;
  readonly campaignId: string;
};

function readAuthorityFile(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CAPABILITY_EVIDENCE_BYTES) throw new TypeError('authority file refused');
  const source = readFileSync(path, 'utf8');
  if (Buffer.byteLength(source) > MAX_CAPABILITY_EVIDENCE_BYTES) throw new TypeError('authority file refused');
  return source;
}

function currentPromotion(
  events: Awaited<ReturnType<FilePromotionLedger['read']>>,
  target: Parameters<typeof samePromotionTarget>[0],
  manifestSource: string,
): boolean {
  const manifestRef = maskedPromotionRef('manifest', createHash('sha256').update(manifestSource).digest('hex'));
  const latest = [...events].reverse().find((event) => event.outcome === 'applied' && samePromotionTarget(event.target, target));
  return latest?.action === 'promote' && latest.toMaturity === 'field_verified' && latest.manifestRef === manifestRef;
}

function exactTarget(input: ResolveWriteAuthorityInput, target: {
  readonly productId: string;
  readonly capabilityId: string;
  readonly toolId: string;
}): boolean {
  return target.productId === input.expected.product
    && target.capabilityId === input.expected.capabilityId
    && target.toolId === input.expected.toolId;
}

function candidateComplete(manifest: ReturnType<typeof parseGroundedCapabilityEvidence>, context: ReturnType<typeof parseEvidenceValidationContext>): boolean {
  const passingCodes = new Set<string>(manifest.negativeCases
    .filter(({ result }) => result === 'pass')
    .map(({ caseCode }) => String(caseCode)));
  return context.campaign === 'mock_mutation'
    && context.runIdentities.every(({ environment }) => environment === 'mock')
    && manifest.o5Counters.runCount >= 3
    && manifest.o5Counters.passCount === manifest.o5Counters.runCount
    && manifest.o5Counters.mutationCount === manifest.o5Counters.runCount
    && manifest.o5Counters.negativeCasePassCount === 5
    && ['no_op', 'ambiguity', 'read_back_failure', 'disconnect', 'replay'].every((code) => passingCodes.has(code));
}

export async function resolveConfiguredWriteAuthority(input: ResolveWriteAuthorityInput): Promise<ResolvedWriteAuthority> {
  try {
    const policy = loadMaturityPolicyStrict(defaultPolicyRoot());
    const catalog = loadWorkAtomCatalog(defaultCatalogRoot());
    if (!policy.ok || !catalog.ok) return { status: 'refused', code: 'AUTHORITY_GROUNDING_UNAVAILABLE' };
    const context = buildCoverageContext({
      catalogRoot: defaultCatalogRoot(), evidenceRoot: input.references.evidenceRoot,
      registeredTools: [input.expected.toolId], maturityPolicy: policy.entries,
    });
    const manifestSource = readAuthorityFile(input.references.manifestPath);
    const manifest = parseGroundedCapabilityEvidence({ source: manifestSource, grounding: { atoms: catalog.atoms, context } });
    if (!exactTarget(input, manifest.target)) return { status: 'refused', code: 'AUTHORITY_TARGET_MISMATCH' };
    const validationContext = parseEvidenceValidationContext(JSON.parse(readAuthorityFile(input.references.validationContextPath)));
    const baseline = context.maturityByCapability.get(`${input.expected.product}::${input.expected.capabilityId}`);
    if (baseline === undefined) return { status: 'refused', code: 'AUTHORITY_POLICY_MISSING' };
    const ledger = FilePromotionLedger.open(
      input.references.ledgerPath,
      process.env.SANGFOR_CAPABILITY_PROMOTION_LEDGER_SECRET,
      process.env.SANGFOR_CAPABILITY_PROMOTION_CHECKPOINT_SECRET,
    );
    ledger.read();
    if (input.persistence === 'read_only') {
      const validation = validateCapabilityEvidence({
        manifest, evidenceRoot: input.references.evidenceRoot,
        filesystem: nodeEvidenceFilesystem(), context: validationContext,
      });
      if (validation.status !== 'active') return { status: 'refused', code: 'AUTHORITY_EVIDENCE_INACTIVE' };
    } else {
      const validation = await validateAndPersistEvidenceStaleness({
        manifestSource, manifest, evidenceRoot: input.references.evidenceRoot,
        filesystem: nodeEvidenceFilesystem(), context: validationContext, baseline, ledger,
      });
      if (validation.status !== 'no_change') return { status: 'refused', code: 'AUTHORITY_EVIDENCE_INACTIVE' };
    }
    const events = ledger.read();
    const maturity: Maturity = deriveEffectiveMaturity(baseline, manifest.target, events);
    const firstRun = manifest.runs[0];
    if (firstRun === undefined) return { status: 'refused', code: 'AUTHORITY_RUN_MISSING' };
    const scope: DerivedAuthorityScope = {
      product: manifest.target.productId,
      capabilityId: manifest.target.capabilityId,
      toolId: manifest.target.toolId,
      targetEnvironment: validationContext.targetEnvironment ?? 'unclassified',
      deviceId: validationContext.currentDigests.deviceIdentityDigest,
      originDigest: validationContext.currentDigests.originDigest,
      firmwareId: validationContext.currentFirmware.truthDigest,
      firmwareTruth: {
        recordId: manifest.firmwareTruth.recordId,
        vendor: manifest.firmwareTruth.vendor,
        adapterProduct: manifest.firmwareTruth.adapterProduct,
        productVariant: manifest.firmwareTruth.productVariant,
        versionRaw: manifest.firmwareTruth.versionRaw,
        versionFamily: manifest.firmwareTruth.versionFamily,
        revision: manifest.firmwareTruth.revision,
        buildId: manifest.firmwareTruth.buildId,
        hotfix: manifest.firmwareTruth.hotfix,
        uiFingerprint: manifest.firmwareTruth.uiFingerprint,
        apiFingerprint: manifest.firmwareTruth.apiFingerprint,
        status: manifest.firmwareTruth.status,
        observedAt: manifest.firmwareTruth.observedAt,
        specVersion: manifest.firmwareTruth.specVersion,
        specApplicability: manifest.firmwareTruth.specApplicability,
        truthDigest: manifest.firmwareTruth.truthDigest,
      },
      implementation: {
        recipeDigest: validationContext.currentDigests.recipeDigest,
        toolDigest: validationContext.currentDigests.toolDigest,
        runtimeDigest: validationContext.currentDigests.runtimeDigest,
      },
      windowId: validationContext.currentDigests.windowIdentityDigest,
      sessionId: firstRun.id,
      campaignId: manifest.manifestId,
    };
    if (input.expected.mode === 'ordinary_field') {
      return maturity === 'field_verified' && currentPromotion(events, manifest.target, manifestSource)
        ? { status: 'ordinary_active', scope, maturity }
        : { status: 'refused', code: 'AUTHORITY_ACTIVE_PROMOTION_REQUIRED' };
    }
    return maturity === 'tested_mock' && candidateComplete(manifest, validationContext)
      ? { status: 'bootstrap_candidate', scope, maturity }
      : { status: 'refused', code: 'AUTHORITY_MOCK_CANDIDATE_REQUIRED' };
  } catch {
    return { status: 'refused', code: 'AUTHORITY_UNAVAILABLE' };
  }
}
