import type {
  BrowserExecutionPort,
  BrowserExecutionRequest,
  BrowserExecutionResult,
} from '@sangfor/browser-contracts';
import { digestIagMutationAction } from './iag-action-authority.js';
import { canonicalIagValuesEqual } from './iag-mutation-canonical.js';
import type { GroundedIagMutationAction, IagMutationObservedState } from './iag-mutation-action.js';
import {
  resolveIagPolicyObservation,
  type IagObservationResolution,
} from './iag-observation.js';
import {
  digestIagObservedState,
  parseIagReadBackProof,
  type GroundedIagReadBackProof,
} from './iag-readback-authority.js';

export type IagIndependentReadBack = {
  readonly status: 'MATCHED' | 'MISMATCHED' | 'INDETERMINATE';
  readonly request: BrowserExecutionRequest;
  readonly raw?: BrowserExecutionResult;
  readonly proof: GroundedIagReadBackProof;
  readonly error?: { readonly code: 'READ_BACK_ERROR'; readonly message: string };
};

function readBackRequest(action: GroundedIagMutationAction): BrowserExecutionRequest {
  return {
    schemaVersion: 'browser-execution-request.v1',
    requestId: `${action.bindings.idempotencyKey}-independent-readback`,
    sessionId: action.readBackExpectation.verifierSessionId,
    origin: action.target.origin,
    operation: { kind: 'observe_console', includeSnapshot: true },
  };
}

function proofFrom(input: {
  readonly action: GroundedIagMutationAction;
  readonly status: IagIndependentReadBack['status'];
  readonly observed: IagMutationObservedState | { readonly kind: 'UNAVAILABLE'; readonly reasonCode: string };
  readonly now: Date;
}): GroundedIagReadBackProof {
  const source = {
    schemaVersion: 'iag-independent-readback.v1',
    action: input.action,
    actionDigest: digestIagMutationAction(input.action),
    verifierSessionId: input.action.readBackExpectation.verifierSessionId,
    result: input.status,
    expected: input.action.readBackExpectation.expected,
    observed: input.observed,
    observedStateDigest: input.status === 'INDETERMINATE' ? null : digestIagObservedState(input.observed),
    observedAt: input.now.toISOString(),
  };
  const parsed = parseIagReadBackProof({ source: JSON.stringify(source), action: input.action });
  if (!parsed.ok) throw new TypeError(`IAG_READ_BACK_PROOF_CONSTRUCTION_FAILED:${parsed.refusal.code}`);
  return parsed.value;
}

function statusFromResolution(resolution: IagObservationResolution, action: GroundedIagMutationAction): {
  readonly status: IagIndependentReadBack['status'];
  readonly observed: IagMutationObservedState | { readonly kind: 'UNAVAILABLE'; readonly reasonCode: string };
} {
  switch (resolution.status) {
    case 'EXACT':
      return canonicalIagValuesEqual(resolution.observed, action.readBackExpectation.expected)
        ? { status: 'MATCHED', observed: resolution.observed }
        : { status: 'MISMATCHED', observed: resolution.observed };
    case 'ABSENT':
      return { status: 'MISMATCHED', observed: resolution.observed };
    case 'AMBIGUOUS':
    case 'MISSING':
    case 'UNREADY':
    case 'REFUSED':
      return { status: 'INDETERMINATE', observed: { kind: 'UNAVAILABLE', reasonCode: resolution.reasonCode } };
    default:
      resolution satisfies never;
      return { status: 'INDETERMINATE', observed: { kind: 'UNAVAILABLE', reasonCode: 'READ_BACK_UNKNOWN' } };
  }
}

export async function independentlyReadBackIag(input: {
  readonly action: GroundedIagMutationAction;
  readonly port: BrowserExecutionPort;
  readonly now: () => Date;
}): Promise<IagIndependentReadBack> {
  const request = readBackRequest(input.action);
  try {
    const raw = await input.port.execute(request);
    const resolved = statusFromResolution(resolveIagPolicyObservation({
      action: input.action, result: raw, requestId: request.requestId,
    }), input.action);
    return {
      status: resolved.status,
      request,
      raw,
      proof: proofFrom({ action: input.action, status: resolved.status, observed: resolved.observed, now: input.now() }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown read-back error';
    const status = 'INDETERMINATE' as const;
    return {
      status,
      request,
      proof: proofFrom({
        action: input.action, status,
        observed: { kind: 'UNAVAILABLE', reasonCode: 'READ_BACK_ERROR' }, now: input.now(),
      }),
      error: { code: 'READ_BACK_ERROR', message },
    };
  }
}
