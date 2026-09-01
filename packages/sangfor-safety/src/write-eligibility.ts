export const WRITE_ELIGIBILITY_OUTCOMES = [
  'NORMAL_ACTIVE_EVIDENCE',
  'O1_IAG_CANDIDATE_BOOTSTRAP',
  'REFUSED',
] as const;

export const O1_ACTION_KINDS = ['single_url_exception', 'single_application_exception'] as const;
export const O1_NEGATIVE_CASE_CODES = ['no_op', 'ambiguity', 'read_back_failure', 'disconnect', 'replay'] as const;

export type WriteScope = {
  readonly product: string;
  readonly capabilityId: string;
  readonly deviceId: string;
  readonly firmwareId: string;
  readonly windowId: string;
  readonly sessionId: string;
  readonly originId: string;
  readonly campaignId: string;
};

export type ActiveWriteEvidence =
  | { readonly status: 'active'; readonly scope: WriteScope }
  | { readonly status: 'stale' | 'refused' | 'unavailable' };

export type OrdinaryWriteEligibilityInput = {
  readonly kind: 'ordinary';
  readonly target: 'loopback' | 'non_loopback';
  readonly scope: WriteScope;
  readonly allowRealExecution: boolean;
  readonly allowProductionExecution: boolean;
  readonly safety: {
    readonly safetyClass: 'auto_allowed' | 'read_only' | 'human_only';
    readonly maturity: 'planned' | 'implemented_local' | 'tested_mock' | 'field_verified';
    readonly autoAllowed: boolean;
    readonly fieldVerifiedAutoAllowed: boolean;
  };
  readonly evidence: ActiveWriteEvidence;
};

export type IagBootstrapScope = WriteScope & {
  readonly actionKind: string;
  readonly targetEnvironment: string;
};

export type IagBootstrapEligibilityInput = {
  readonly kind: 'iag_evidence_bootstrap';
  readonly scope: IagBootstrapScope;
  readonly maturity: 'planned' | 'implemented_local' | 'tested_mock' | 'field_verified';
  readonly mockEvidence: {
    readonly status: string;
    readonly negativeCaseCodes: readonly string[];
  };
  readonly activeEvidence: ActiveWriteEvidence;
  readonly target: 'loopback' | 'non_loopback';
  readonly allowRealExecution: boolean;
  readonly allowProductionExecution: boolean;
  readonly approvalPurpose: string;
};

export type WriteEligibilityInput = OrdinaryWriteEligibilityInput | IagBootstrapEligibilityInput;

export type WriteEligibility =
  | {
    readonly kind: 'NORMAL_ACTIVE_EVIDENCE';
    readonly executionClass: 'ordinary_live' | 'mock_only';
    readonly promotionEligible: boolean;
  }
  | { readonly kind: 'O1_IAG_CANDIDATE_BOOTSTRAP'; readonly promotionEligible: false }
  | { readonly kind: 'REFUSED'; readonly code: string; readonly promotionEligible: false };

function refused(code: string): WriteEligibility {
  return { kind: 'REFUSED', code, promotionEligible: false };
}

function sameScope(left: WriteScope, right: WriteScope): boolean {
  return left.product === right.product
    && left.capabilityId === right.capabilityId
    && left.deviceId === right.deviceId
    && left.firmwareId === right.firmwareId
    && left.windowId === right.windowId
    && left.sessionId === right.sessionId
    && left.originId === right.originId
    && left.campaignId === right.campaignId;
}

function ordinaryEligibility(input: OrdinaryWriteEligibilityInput): WriteEligibility {
  if (input.target === 'loopback') {
    return { kind: 'NORMAL_ACTIVE_EVIDENCE', executionClass: 'mock_only', promotionEligible: false };
  }
  if (!input.allowRealExecution || !input.allowProductionExecution) {
    return refused('ORDINARY_DOUBLE_EXECUTION_GATE_REQUIRED');
  }
  if (!input.safety.autoAllowed || !input.safety.fieldVerifiedAutoAllowed
    || input.safety.safetyClass !== 'auto_allowed' || input.safety.maturity !== 'field_verified') {
    return refused('ORDINARY_FIELD_VERIFIED_AUTO_ALLOWED_REQUIRED');
  }
  if (input.evidence.status !== 'active') return refused('ORDINARY_ACTIVE_EXACT_SCOPE_EVIDENCE_REQUIRED');
  if (!sameScope(input.scope, input.evidence.scope)) return refused('ORDINARY_EVIDENCE_SCOPE_MISMATCH');
  return { kind: 'NORMAL_ACTIVE_EVIDENCE', executionClass: 'ordinary_live', promotionEligible: true };
}

function completeScope(scope: IagBootstrapScope): boolean {
  return [
    scope.deviceId,
    scope.firmwareId,
    scope.windowId,
    scope.sessionId,
    scope.originId,
    scope.campaignId,
  ].every((value) => value.trim().length > 0);
}

function bootstrapEligibility(input: IagBootstrapEligibilityInput): WriteEligibility {
  if (input.scope.product !== 'IAG' || input.scope.capabilityId !== 'internet_policy') {
    return refused('IAG_BOOTSTRAP_TARGET_REFUSED');
  }
  if (!O1_ACTION_KINDS.some((kind) => kind === input.scope.actionKind)) return refused('IAG_BOOTSTRAP_ACTION_REFUSED');
  if (input.scope.targetEnvironment !== 'lab') return refused('IAG_BOOTSTRAP_LAB_SCOPE_REQUIRED');
  if (input.target !== 'non_loopback') return refused('IAG_BOOTSTRAP_REAL_TARGET_REQUIRED');
  if (!completeScope(input.scope)) return refused('IAG_BOOTSTRAP_EXACT_IDS_REQUIRED');
  if (input.maturity !== 'tested_mock') return refused('IAG_BOOTSTRAP_TESTED_MOCK_REQUIRED');
  if (input.activeEvidence.status === 'active') return refused('IAG_BOOTSTRAP_ACTIVE_EVIDENCE_EXISTS');
  if (input.activeEvidence.status === 'stale' || input.activeEvidence.status === 'refused') {
    return refused('IAG_BOOTSTRAP_EVIDENCE_STATE_REFUSED');
  }
  if (input.mockEvidence.status !== 'completed_green'
    || input.mockEvidence.negativeCaseCodes.length !== O1_NEGATIVE_CASE_CODES.length
    || !O1_NEGATIVE_CASE_CODES.every((code) => input.mockEvidence.negativeCaseCodes.includes(code))) {
    return refused('IAG_BOOTSTRAP_MOCK_EVIDENCE_INCOMPLETE');
  }
  if (!input.allowRealExecution || !input.allowProductionExecution) return refused('IAG_BOOTSTRAP_DOUBLE_EXECUTION_GATE_REQUIRED');
  if (input.approvalPurpose !== 'evidence_bootstrap') return refused('IAG_BOOTSTRAP_PURPOSE_REFUSED');
  return { kind: 'O1_IAG_CANDIDATE_BOOTSTRAP', promotionEligible: false };
}

export function resolveWriteEligibility(input: WriteEligibilityInput): WriteEligibility {
  switch (input.kind) {
    case 'ordinary':
      return ordinaryEligibility(input);
    case 'iag_evidence_bootstrap':
      return bootstrapEligibility(input);
    default:
      return assertNever(input);
  }
}

function assertNever(value: never): never {
  throw new TypeError(`Unhandled write eligibility input: ${JSON.stringify(value)}`);
}
