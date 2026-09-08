import type { AuthorityDatabase } from '../authority-store-contracts.js';
import type { AuthorityAggregate } from '../migration-manifest.js';
import { AUTHORITY_ADAPTER_POLICIES } from './adapter-policy.js';
import { AuditCutoverTarget, EvidenceCutoverTarget, RegistryCutoverTarget, RunsCutoverTarget } from './core-aggregate-targets.js';
import { AuthorityCutoverError } from './errors.js';
import { FilesystemCutoverSourceAdapter } from './filesystem-source.js';
import {
  CapabilityCutoverTarget, ChronicleCutoverTarget, EvalCutoverTarget, FeedbackCutoverTarget,
  LearningCutoverTarget, PmTaskCutoverTarget, WikiCutoverTarget,
} from './domain-targets.js';
import { InvalidateOnCutoverAdapter, PostgresNativeAdapter } from './policy-adapters.js';
import type { TargetScope } from './postgres-target-base.js';
import type { CutoverSourceAdapter, CutoverTargetAdapter } from './types.js';

export type AdapterRegistryOptions = TargetScope & {
  readonly database: AuthorityDatabase; readonly sourceRoot: string; readonly expectedFiles: readonly string[];
  readonly auditSecret?: string; readonly promotionLedgerSecret?: string; readonly promotionCheckpointSecret?: string;
};
export type ResolvedCutoverAdapter =
  | { readonly policy: 'backfill'; readonly source: CutoverSourceAdapter; readonly target: CutoverTargetAdapter }
  | { readonly policy: 'invalidate_on_cutover'; readonly adapter: InvalidateOnCutoverAdapter }
  | { readonly policy: 'postgres_native'; readonly adapter: PostgresNativeAdapter };

function backfillTarget(aggregate: AuthorityAggregate, options: AdapterRegistryOptions): CutoverTargetAdapter {
  switch (aggregate) {
    case 'registry_services': return new RegistryCutoverTarget(options.database, options);
    case 'runs_steps': return new RunsCutoverTarget(options.database, options);
    case 'audit': return new AuditCutoverTarget(options.database, options, options.auditSecret ?? '');
    case 'evidence': return new EvidenceCutoverTarget(options.database, options);
    case 'pm_tasks': return new PmTaskCutoverTarget(options.database, options);
    case 'feedback_lessons': return new FeedbackCutoverTarget(options.database, options);
    case 'evals': return new EvalCutoverTarget(options.database, options);
    case 'wiki_proposals': return new WikiCutoverTarget(options.database, options);
    case 'learning_strategy_lifecycle': return new LearningCutoverTarget(options.database, options);
    case 'config_chronicle_state': return new ChronicleCutoverTarget(options.database, options);
    case 'capability_evidence_promotion': return new CapabilityCutoverTarget(options.database, options);
    default: throw new AuthorityCutoverError('CUTOVER_TARGET_POLICY_INVALID');
  }
}

export function resolveCutoverAdapter(aggregate: AuthorityAggregate, options: AdapterRegistryOptions): ResolvedCutoverAdapter {
  const policy = AUTHORITY_ADAPTER_POLICIES.find((entry) => entry.aggregate === aggregate);
  if (!policy) throw new AuthorityCutoverError('CUTOVER_POLICY_UNKNOWN');
  if (policy.policy === 'invalidate_on_cutover') return { policy: policy.policy, adapter: new InvalidateOnCutoverAdapter(aggregate, options.projectId) };
  if (policy.policy === 'postgres_native') return { policy: policy.policy, adapter: new PostgresNativeAdapter(options.database, aggregate, options.projectId) };
  const source = new FilesystemCutoverSourceAdapter({
    aggregate, tenantId: options.tenantId, sourceRoot: options.sourceRoot, expectedFiles: options.expectedFiles,
    ...(options.auditSecret === undefined ? {} : { auditSecret: options.auditSecret }),
    ...(options.promotionLedgerSecret === undefined ? {} : { promotionLedgerSecret: options.promotionLedgerSecret }),
    ...(options.promotionCheckpointSecret === undefined ? {} : { promotionCheckpointSecret: options.promotionCheckpointSecret }),
  });
  return { policy: 'backfill', source, target: backfillTarget(aggregate, options) };
}
