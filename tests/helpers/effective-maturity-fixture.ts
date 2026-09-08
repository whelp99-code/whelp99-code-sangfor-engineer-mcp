import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FilePromotionLedger,
  buildCoverageContext,
  computeEffectiveReplacementCoverage,
  maskedPromotionRef,
  type EvidenceValidationContext,
  type PromotionLedgerEventInput,
} from '../../packages/sangfor-competency/src/index.js';
import { writeValidationFixture } from './capability-evidence-validation-fixture.js';
import { testPromotionLedger } from './local-write-authority.js';

const LEDGER_SECRET = 'todo-10-ledger-secret-at-least-32-bytes';
const CHECKPOINT_SECRET = 'todo-10-checkpoint-secret-at-least-32-bytes';

export async function createEffectiveFixture(campaign: 'api_read_only' | 'browser' = 'api_read_only') {
  const roots: string[] = [];
  const root = (): string => {
    const value = mkdtempSync(join(tmpdir(), 'effective-maturity-'));
    roots.push(value);
    return value;
  };
  const evidenceRoot = root();
  const fixture = writeValidationFixture(evidenceRoot, campaign);
  const manifestSource = JSON.stringify(fixture.manifest);
  const catalogRoot = root();
  writeFileSync(join(evidenceRoot, 'catalog-citation.md'), 'historical catalog citation\n');
  writeFileSync(join(catalogRoot, 'work-atoms.json'), JSON.stringify({ version: 1, atoms: [{
    id: 'op_daily_health', product: 'HCI_SCP', phase: 'operate', title: 'daily health',
    automatability: 'auto', coveredBy: 'sangfor_evaluate_config', maturity: 'field_verified',
    evidence: 'catalog-citation.md', capabilityRef: { product: 'HCI_SCP', capabilityId: 'resource_inventory' },
  }] }));
  const context = buildCoverageContext({
    catalogRoot,
    evidenceRoot,
    registeredTools: ['sangfor_evaluate_config'],
    maturityPolicy: [{ product: 'HCI_SCP', capabilityId: 'resource_inventory', maturity: 'tested_mock' }],
  });
  const ledgerPath = join(root(), 'promotion.jsonl');
  const ledger = await testPromotionLedger(ledgerPath, LEDGER_SECRET, CHECKPOINT_SECRET);
  const manifestDigest = createHash('sha256').update(manifestSource).digest('hex');
  const manifestRef = maskedPromotionRef('manifest', manifestDigest);
  const event = (input: {
    readonly index: number;
    readonly action: 'promote' | 'emergency_demote';
    readonly fromMaturity: 'tested_mock' | 'field_verified';
    readonly toMaturity: 'tested_mock' | 'field_verified';
    readonly manifestRef?: string;
  }): PromotionLedgerEventInput => ({
    version: 1,
    eventId: `event-${input.index}`,
    at: `2026-08-25T13:${String(input.index).padStart(2, '0')}:00.000Z`,
    outcome: 'applied',
    action: input.action,
    target: fixture.manifest.target,
    fromMaturity: input.fromMaturity,
    toMaturity: input.toMaturity,
    decisionRef: maskedPromotionRef('decision', `decision-${input.index}`),
    manifestRef: input.manifestRef ?? manifestRef,
    nonceRef: maskedPromotionRef('nonce', `nonce-${input.index}`),
    refusalCode: null,
  });
  const claim = { manifestSource, evidenceRoot, context: fixture.context };
  return {
    context, fixture, ledger, ledgerPath, manifestRef, event, claim,
    cleanup: () => { for (const value of roots) rmSync(value, { recursive: true, force: true }); },
  };
}

export async function computeFixtureCoverage(
  value: Awaited<ReturnType<typeof createEffectiveFixture>>,
  overrides: {
    readonly validationContext?: EvidenceValidationContext;
    readonly claims?: readonly (typeof value.claim)[];
  } = {},
) {
  return await computeEffectiveReplacementCoverage(value.context, {
    claims: overrides.claims ?? [{ ...value.claim, context: overrides.validationContext ?? value.claim.context }],
    ledger: value.ledger,
  });
}

export function requireEffectiveReport(result: Awaited<ReturnType<typeof computeFixtureCoverage>>) {
  if (!result.ok) throw new Error('expected effective report');
  return result.report;
}
