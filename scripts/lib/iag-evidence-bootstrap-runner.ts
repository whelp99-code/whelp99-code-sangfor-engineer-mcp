import { authorizeIagEvidenceBootstrap } from '../../packages/sangfor-operator/src/iag-evidence-bootstrap.js';
import {
  resolveConfiguredWriteAuthority,
  type DerivedAuthorityScope,
  type ResolvedWriteAuthority,
} from '../../packages/sangfor-competency/src/write-authority.js';
import type { IagBootstrapScope, WriteEligibility } from '../../packages/sangfor-safety/src/index.js';
import type { IagEvidenceBootstrapCommand } from './iag-evidence-bootstrap-input.js';

const BOOTSTRAP_EXPECTATION = {
  product: 'IAG',
  capabilityId: 'internet_policy',
  toolId: 'iag_o1_evidence_campaign',
  mode: 'bootstrap_mock',
} as const;

export type IagEvidenceBootstrapRunCommand = Extract<IagEvidenceBootstrapCommand, { readonly kind: 'run' }>;

/**
 * The one seam that may act on an authorized action. It is injected, never
 * composed here: this module owns the refusal decision, and whatever creates a
 * browser, session, or device stays outside it.
 */
export type IagEvidenceBootstrapExecutionSeam = (action: IagBootstrapScope) => Promise<void>;

export type IagEvidenceBootstrapOutcome =
  | { readonly kind: 'REFUSED'; readonly code: string; readonly executorCalls: 0 }
  | {
    readonly kind: 'HANDED_TO_EXECUTION';
    readonly action: IagBootstrapScope;
    readonly promotionEligible: false;
    readonly executorCalls: 1;
  };

export type IagEvidenceBootstrapRunInput = {
  readonly command: IagEvidenceBootstrapRunCommand;
  readonly approval: unknown;
  readonly createExecution?: IagEvidenceBootstrapExecutionSeam;
};

type CandidateAuthority =
  | { readonly ok: true; readonly scope: DerivedAuthorityScope }
  | { readonly ok: false; readonly code: string };

function refused(code: string): IagEvidenceBootstrapOutcome {
  return { kind: 'REFUSED', code, executorCalls: 0 };
}

function assertNever(value: never): never {
  throw new TypeError(`Unhandled bootstrap authority state: ${JSON.stringify(value)}`);
}

function bootstrapCandidate(resolved: ResolvedWriteAuthority): CandidateAuthority {
  switch (resolved.status) {
    case 'bootstrap_candidate':
      return { ok: true, scope: resolved.scope };
    case 'ordinary_active':
      return { ok: false, code: 'AUTHORITY_MOCK_CANDIDATE_REQUIRED' };
    case 'refused':
      return { ok: false, code: resolved.code };
    default:
      return assertNever(resolved);
  }
}

function eligibilityRefusal(eligibility: WriteEligibility): string | undefined {
  switch (eligibility.kind) {
    case 'O1_IAG_CANDIDATE_BOOTSTRAP':
      return undefined;
    case 'NORMAL_ACTIVE_EVIDENCE':
      return 'IAG_BOOTSTRAP_CANDIDATE_OUTCOME_REQUIRED';
    case 'REFUSED':
      return eligibility.code;
    default:
      return assertNever(eligibility);
  }
}

/**
 * The exact O1 action. Every identity is copied from the resolved authority so
 * the caller cannot widen the scope it was granted; the command contributes only
 * the origin it addressed and the action kind it named.
 */
function derivedO1Action(
  command: IagEvidenceBootstrapRunCommand,
  scope: DerivedAuthorityScope,
): IagBootstrapScope {
  return {
    product: scope.product,
    capabilityId: scope.capabilityId,
    toolId: scope.toolId,
    deviceId: scope.deviceId,
    firmwareId: scope.firmwareId,
    firmwareTruth: scope.firmwareTruth,
    implementation: scope.implementation,
    windowId: scope.windowId,
    sessionId: scope.sessionId,
    campaignId: scope.campaignId,
    originId: command.originId,
    actionKind: command.actionKind,
    targetEnvironment: scope.targetEnvironment,
  };
}

/**
 * Resolves authority first, so a missing, non-candidate, or unreadable authority
 * refuses before an approval nonce is consumed and before any execution seam is
 * asked for. Only the authorized action reaches the injected seam.
 */
export async function runIagEvidenceBootstrap(
  input: IagEvidenceBootstrapRunInput,
): Promise<IagEvidenceBootstrapOutcome> {
  const authority = bootstrapCandidate(await resolveConfiguredWriteAuthority({
    references: input.command.references,
    persistence: 'read_only',
    expected: BOOTSTRAP_EXPECTATION,
  }));
  if (!authority.ok) return refused(authority.code);
  if (input.approval === undefined) return refused('IAG_BOOTSTRAP_APPROVAL_REQUIRED');
  const createExecution = input.createExecution;
  if (createExecution === undefined) return refused('IAG_BOOTSTRAP_EXECUTION_SEAM_REQUIRED');
  const action = derivedO1Action(input.command, authority.scope);
  const refusal = eligibilityRefusal(await authorizeIagEvidenceBootstrap({
    action,
    authority: input.command.references,
    approval: input.approval,
  }));
  if (refusal !== undefined) return refused(refusal);
  await createExecution(action);
  return { kind: 'HANDED_TO_EXECUTION', action, promotionEligible: false, executorCalls: 1 };
}
