import { createHash } from 'node:crypto';
import { resolveIagMutationActionAuthority } from '@sangfor/competency';
import { digestIagMutationAction, parseIagMutationAction } from '../apply/iag-action-authority.js';
import type { GroundedIagMutationAction } from '../apply/iag-mutation-action.js';
import { reconcileIagRun, resolveUncertainReplay } from './commit-resolution.js';
import { groundIagApplyResult, type IagApplyResult, ungroundedRefusal } from './result.js';
import type { IagOrchestratorRuntime } from './runtime.js';
import { executeFreshIagRun, type IagOrchestratorRequest } from './run-machine.js';

export type { IagOrchestratorRequest } from './run-machine.js';
export interface IagOrchestrator {
  execute(request: IagOrchestratorRequest): Promise<IagApplyResult>;
  reconcile(runId: string): IagApplyResult;
}

function digest(domain: string, value: string): string {
  return createHash('sha256').update(`${domain}\0${value}`, 'utf8').digest('hex');
}
function runIdFor(action: GroundedIagMutationAction): string {
  return digest('iag-orchestrator-run', action.bindings.idempotencyKey);
}
function refusal(runId: string, action: GroundedIagMutationAction, reasonCode: string): IagApplyResult {
  return groundIagApplyResult({
    runId, outcome: 'REFUSED', action, mutationAttempted: false, reasonCode,
  });
}
function durableUngrounded(input: {
  readonly runtime: IagOrchestratorRuntime; readonly runId: string;
  readonly requestDigest: string; readonly reasonCode: string;
}): IagApplyResult {
  const { runtime, runId, requestDigest, reasonCode } = input;
  const claim = runtime.store.claim(runId, requestDigest);
  if (claim.kind === 'REPLAY') return claim.result;
  if (claim.kind !== 'FRESH') {
    return ungroundedRefusal(
      runId, claim.kind === 'CONFLICT' ? 'IDEMPOTENCY_CONFLICT' : 'RUN_RECONCILIATION_REQUIRED',
    );
  }
  const result = ungroundedRefusal(runId, reasonCode);
  runtime.store.terminal(runId, requestDigest, result);
  return result;
}

export function createIagOrchestrator(runtime: IagOrchestratorRuntime): IagOrchestrator {
  const active = new Map<string, Promise<IagApplyResult>>();
  return {
    async execute(request) {
      const authority = await resolveIagMutationActionAuthority(request.authorityRequest);
      const malformedRunId = digest('iag-orchestrator-malformed', request.actionSource);
      const malformedDigest = digest('iag-orchestrator-request', request.actionSource);
      if (!authority.ok) return durableUngrounded({
        runtime, runId: malformedRunId, requestDigest: malformedDigest, reasonCode: authority.code,
      });
      const parsed = parseIagMutationAction({ source: request.actionSource, authority: authority.authority });
      if (!parsed.ok) {
        return durableUngrounded({
          runtime, runId: malformedRunId, requestDigest: malformedDigest,
          reasonCode: parsed.refusal.code.toUpperCase(),
        });
      }
      const action = parsed.value;
      const runId = runIdFor(action);
      const existing = active.get(runId);
      if (existing !== undefined) return existing;
      const requestDigest = digestIagMutationAction(action);
      const claim = runtime.store.claim(runId, requestDigest);
      switch (claim.kind) {
        case 'REPLAY': return claim.result;
        case 'CONFLICT': return refusal(runId, action, 'IDEMPOTENCY_CONFLICT');
        case 'ACTIVE': return refusal(runId, action, 'RUN_RECONCILIATION_REQUIRED');
        case 'UNCERTAIN': return resolveUncertainReplay({
          runtime, runId, requestDigest, action, mutationAttempted: claim.mutationAttempted,
        });
        case 'FRESH': break;
        default: claim satisfies never;
      }
      const execution = executeFreshIagRun({
        runtime, request, action, runId, requestDigest,
        authorizationClass: authority.authority.authorizationClass,
      });
      active.set(runId, execution);
      return execution.finally(() => active.delete(runId));
    },
    reconcile(runId) {
      return reconcileIagRun(runtime, runId);
    },
  };
}
