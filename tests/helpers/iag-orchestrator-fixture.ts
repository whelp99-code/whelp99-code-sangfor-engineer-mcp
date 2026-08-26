import { join } from 'node:path';
import { resolveIagMutationActionAuthority } from '../../packages/sangfor-competency/src/index.js';
import {
  createIagOrchestrator,
  digestIagMutationAction,
  FileIagOrchestratorStore,
  parseIagMutationAction,
  type IagStoreFaults,
} from '../../packages/sangfor-product-adapters/src/apply/index.js';
import { signIagMutationApproval } from '../../packages/sangfor-operator/src/index.js';
import { replayFixture } from './iag-executor-runtime-fixture.js';
import { urlActionInput } from './iag-mutation-contract-fixture.js';
import { configureAuthorityEnvironment, writeAuthorityFixture } from './write-authorization-authority-fixture.js';

export const IAG_ORCHESTRATOR_NOW = new Date('2026-08-20T11:01:00.000Z');
export const IAG_ORCHESTRATOR_APPROVAL_SECRET = 'iag-orchestrator-approval-secret-32';
const IAG_ORDINARY_APPROVAL_SECRET = 'iag-ordinary-approval-secret-32-bytes';
const LEDGER_SECRET = 'iag-orchestrator-ledger-secret-32';
const CHECKPOINT_SECRET = 'iag-orchestrator-checkpoint-secret-32';

export function configureIagOrchestratorTestEnvironment(root: string): void {
  configureAuthorityEnvironment(root);
  process.env.SANGFOR_ALLOW_REAL_EXECUTION = 'true';
  process.env.SANGFOR_ALLOW_PRODUCTION_EXECUTION = 'true';
  process.env.SANGFOR_IAG_BOOTSTRAP_APPROVAL_SECRET = IAG_ORCHESTRATOR_APPROVAL_SECRET;
  process.env.SANGFOR_NONCE_STORE = 'file';
  process.env.SANGFOR_NONCE_STORE_PATH = join(root, 'nonces.json');
}

export async function iagOrchestratorFixture(input: {
  readonly root: string;
  readonly observed?: 'ABSENT' | 'EXACT_MATCH';
  readonly dryRun?: boolean;
  readonly dispatchBehavior?: 'settle' | 'throw';
  readonly readBackPresent?: boolean;
  readonly faults?: IagStoreFaults;
  readonly authorityKind?: 'bootstrap_candidate' | 'ordinary_active';
}) {
  const observed = input.observed ?? 'ABSENT';
  const ordinary = input.authorityKind === 'ordinary_active';
  const fixture = writeAuthorityFixture({
    root: input.root, product: 'IAG', capabilityId: 'internet_policy',
    toolId: 'iag_o1_evidence_campaign', fieldVerified: ordinary, mockCampaign: !ordinary,
  });
  const authorityRequest = {
    references: fixture.refs, origin: fixture.scope.originId,
    allowedUrlDomains: ['qa.example.invalid'], allowedApplicationIds: [], now: IAG_ORCHESTRATOR_NOW,
    firmwareFreshness: { maxAgeMs: 7_200_000, maxFutureSkewMs: 30_000 },
  } as const;
  const resolved = await resolveIagMutationActionAuthority(authorityRequest);
  if (!resolved.ok) throw new TypeError(resolved.code);
  const sourceValue = { ...urlActionInput(observed, resolved.authority), dryRun: input.dryRun ?? false };
  const parsed = parseIagMutationAction({ source: JSON.stringify(sourceValue), authority: resolved.authority });
  if (!parsed.ok) throw new TypeError(parsed.refusal.code);
  const approvalFields = {
    approvedBy: 'operator-15', changeTicketId: 'CHG-15', rollbackPlanId: 'RB-15',
    purpose: ordinary ? 'ordinary_change' : 'evidence_bootstrap', nonce: `nonce-${observed}-${input.dryRun ?? false}`,
    expiresAt: '2026-08-20T12:00:00.000Z',
  } as const;
  const scope = {
    actionDigest: digestIagMutationAction(parsed.value), origin: parsed.value.target.origin,
    deviceIdentityDigest: parsed.value.target.deviceIdentityDigest,
    sessionId: parsed.value.target.sessionId, windowId: parsed.value.target.windowId,
  };
  const approval = {
    ...approvalFields,
    approvalToken: signIagMutationApproval(ordinary ? IAG_ORDINARY_APPROVAL_SECRET : IAG_ORCHESTRATOR_APPROVAL_SECRET, scope, approvalFields),
  };
  if (ordinary) process.env.SANGFOR_OPERATOR_APPROVAL_SECRET = IAG_ORDINARY_APPROVAL_SECRET;
  const adapterFixture = replayFixture(
    [parsed.value], input.dispatchBehavior ?? 'settle', observed === 'EXACT_MATCH', input.readBackPresent ?? true,
  );
  const store = FileIagOrchestratorStore.initialize({
    ledgerPath: join(input.root, 'orchestrator.jsonl'), ledgerSecret: LEDGER_SECRET,
    checkpointSecret: CHECKPOINT_SECRET, faults: input.faults, now: () => IAG_ORCHESTRATOR_NOW,
  });
  const restart = (faults: IagStoreFaults = {}) => {
    const restartedStore = FileIagOrchestratorStore.initialize({
      ledgerPath: join(input.root, 'orchestrator.jsonl'), ledgerSecret: LEDGER_SECRET,
      checkpointSecret: CHECKPOINT_SECRET, faults, now: () => IAG_ORCHESTRATOR_NOW,
    });
    return {
      store: restartedStore,
      orchestrator: createIagOrchestrator({
        executor: adapterFixture.executor, store: restartedStore, now: () => IAG_ORCHESTRATOR_NOW,
      }),
    };
  };
  return {
    orchestrator: createIagOrchestrator({ executor: adapterFixture.executor, store, now: () => IAG_ORCHESTRATOR_NOW }),
    store, adapterFixture, authorityRequest, source: JSON.stringify(sourceValue), approval,
    action: parsed.value, actionDigest: digestIagMutationAction(parsed.value),
    ledgerPath: join(input.root, 'orchestrator.jsonl'), restart,
  };
}
