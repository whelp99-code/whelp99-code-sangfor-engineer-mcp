import { dirname, join } from 'node:path';
import { FilePromotionLedger, type PromotionLedgerFaults } from '../../packages/sangfor-competency/src/index.js';
import {
  explicitLocalPrimaryAuthority,
  resolveEngagementScopedData,
  resolveRepoData,
  type LocalWriteAuthority,
} from '../../packages/shared/src/index.js';

export function testLocalWriteAuthority(aggregate: string, source?: string): LocalWriteAuthority {
  const sourceRoot = source ?? (aggregate === 'runs_steps'
    ? resolveEngagementScopedData('data/runs', 'SANGFOR_RUNS_ROOT')
    : aggregate === 'audit' ? join(resolveEngagementScopedData('data/evidence', 'SANGFOR_EVIDENCE_ROOT'), 'change-runs')
      : aggregate === 'feedback_lessons' ? resolveEngagementScopedData('data/feedback', 'SANGFOR_FEEDBACK_ROOT')
        : aggregate === 'evals' ? resolveRepoData('data/evals', 'SANGFOR_EVALS_ROOT')
          : aggregate === 'wiki_proposals' ? resolveRepoData('data/wiki', 'SANGFOR_WIKI_ROOT')
            : resolveRepoData('data/registry'));
  return explicitLocalPrimaryAuthority({
    tenantId: 'test-tenant', projectId: process.env.SANGFOR_ENGAGEMENT_ID ?? 'local-primary',
    actorId: 'test-actor', aggregate, sourceRoot,
  });
}

export function testOpenPromotionLedger(
  path: string, ledgerSecret: string | undefined, checkpointSecret: string | undefined,
): FilePromotionLedger {
  return FilePromotionLedger.open(path, ledgerSecret, checkpointSecret,
    testFileLocalWriteAuthority('capability_evidence_promotion', path));
}

export async function testPromotionLedger(
  path: string, ledgerSecret: string, checkpointSecret: string, faults: PromotionLedgerFaults = {},
): Promise<FilePromotionLedger> {
  return FilePromotionLedger.initialize(path, ledgerSecret, checkpointSecret, faults,
    testFileLocalWriteAuthority('capability_evidence_promotion', path));
}

export function testFileLocalWriteAuthority(aggregate: string, path: string): LocalWriteAuthority {
  return testLocalWriteAuthority(aggregate, dirname(path));
}
