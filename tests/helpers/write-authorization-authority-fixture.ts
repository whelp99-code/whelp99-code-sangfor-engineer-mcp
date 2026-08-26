import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { digestCanonicalOrigin } from '../../packages/shared/src/index.js';
import {
  FilePromotionLedger,
  capabilityEvidenceManifestSchema,
  maskedPromotionRef,
  type PromotionLedgerEventInput,
} from '../../packages/sangfor-competency/src/index.js';
import { writeValidationFixture } from './capability-evidence-validation-fixture.js';
import { testFileLocalWriteAuthority } from './local-write-authority.js';

const LEDGER_SECRET = 'write-authority-ledger-secret-32-bytes';
const CHECKPOINT_SECRET = 'write-authority-checkpoint-secret-32';

export type AuthorityFixture = {
  readonly refs: {
    readonly manifestPath: string;
    readonly validationContextPath: string;
    readonly evidenceRoot: string;
    readonly ledgerPath: string;
  };
  readonly manifestSource: string;
  readonly scope: {
    readonly product: string;
    readonly capabilityId: string;
    readonly deviceId: string;
    readonly firmwareId: string;
    readonly windowId: string;
    readonly sessionId: string;
    readonly originId: string;
    readonly campaignId: string;
  };
};

export async function writeAuthorityFixture(input: {
  readonly root: string;
  readonly product: 'IAG' | 'HCI_SCP';
  readonly capabilityId: 'internet_policy' | 'volume_create';
  readonly toolId: string;
  readonly fieldVerified: boolean;
  readonly mockCampaign: boolean;
}): Promise<AuthorityFixture> {
  const evidenceRoot = join(input.root, 'evidence');
  mkdirSync(evidenceRoot, { recursive: true });
  const base = writeValidationFixture(evidenceRoot, 'mutation');
  const atomId = input.product === 'IAG' ? 'iag-o1-policy' : 'hci-volume-create';
  const origin = input.product === 'IAG' ? 'https://192.0.2.21' : 'http://192.0.2.22';
  const firmwareTruth = { ...base.manifest.firmwareTruth, adapterProduct: input.product };
  const digests = { ...base.manifest.digests, originDigest: digestCanonicalOrigin(origin, 'origin') };
  const manifest = capabilityEvidenceManifestSchema.parse({
    ...base.manifest,
    manifestId: `${input.product.toLowerCase()}-${input.mockCampaign ? 'mock' : 'field'}-campaign`,
    target: { productId: input.product, capabilityId: input.capabilityId, toolId: input.toolId, workAtomIds: [atomId] },
    firmwareTruth,
    digests,
  });
  const manifestSource = JSON.stringify(manifest);
  const manifestPath = join(input.root, 'manifest.json');
  const validationContextPath = join(input.root, 'context.json');
  writeFileSync(manifestPath, manifestSource);
  writeFileSync(validationContextPath, JSON.stringify({
    campaign: input.mockCampaign ? 'mock_mutation' : 'mutation',
    evaluatedAt: '2026-08-25T12:00:00.000Z',
    currentFirmware: { ...base.context.currentFirmware, adapterProduct: input.product },
    currentDigests: digests,
    reviewer: { actorId: base.context.reviewerActorId, actorType: 'human_pm' },
    runIdentities: base.context.runIdentities.map((identity) => ({
      ...identity,
      environment: input.mockCampaign ? 'mock' : 'real_device',
    })),
  }));

  const competencyRoot = join(input.root, 'competency');
  mkdirSync(competencyRoot, { recursive: true });
  writeFileSync(join(competencyRoot, 'work-atoms.json'), JSON.stringify({ version: 1, atoms: [{
    id: atomId,
    product: input.product,
    phase: 'deploy',
    title: `${input.product} write authority fixture`,
    automatability: 'auto',
    coveredBy: input.toolId,
    maturity: input.fieldVerified ? 'field_verified' : 'tested_mock',
    evidence: 'fixture',
    capabilityRef: { product: input.product, capabilityId: input.capabilityId },
  }] }));
  writeFileSync(join(competencyRoot, 'capability-maturity.json'), JSON.stringify({ version: 1, entries: [{
    product: input.product,
    capabilityId: input.capabilityId,
    maturity: 'tested_mock',
    evidence: 'fixture',
  }] }));

  const ledgerPath = join(input.root, 'promotion.jsonl');
  const ledger = await FilePromotionLedger.initialize(ledgerPath, LEDGER_SECRET, CHECKPOINT_SECRET, {}, testFileLocalWriteAuthority('capability_evidence_promotion', ledgerPath));
  if (input.fieldVerified) {
    const event: PromotionLedgerEventInput = {
      version: 1,
      eventId: 'field-promotion-event',
      at: '2026-08-25T12:00:00.000Z',
      outcome: 'applied',
      action: 'promote',
      target: manifest.target,
      fromMaturity: 'tested_mock',
      toMaturity: 'field_verified',
      decisionRef: maskedPromotionRef('decision', 'field-promotion'),
      manifestRef: maskedPromotionRef('manifest', createHash('sha256').update(manifestSource).digest('hex')),
      nonceRef: maskedPromotionRef('nonce', 'field-promotion'),
      refusalCode: null,
    };
    await ledger.append(event);
  }

  return {
    refs: { manifestPath, validationContextPath, evidenceRoot, ledgerPath },
    manifestSource,
    scope: {
      product: input.product,
      capabilityId: input.capabilityId,
      deviceId: manifest.digests.deviceIdentityDigest,
      firmwareId: manifest.firmwareTruth.truthDigest,
      windowId: manifest.digests.windowIdentityDigest,
      sessionId: manifest.runs[0]?.id ?? 'missing-run',
      originId: origin,
      campaignId: manifest.manifestId,
    },
  };
}

export function configureAuthorityEnvironment(root: string): void {
  process.env.SANGFOR_COMPETENCY_ROOT = join(root, 'competency');
  process.env.SANGFOR_CAPABILITY_PROMOTION_LEDGER_SECRET = LEDGER_SECRET;
  process.env.SANGFOR_CAPABILITY_PROMOTION_CHECKPOINT_SECRET = CHECKPOINT_SECRET;
}
