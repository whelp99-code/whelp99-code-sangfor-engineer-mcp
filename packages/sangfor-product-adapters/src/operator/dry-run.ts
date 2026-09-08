import { createHash } from 'node:crypto';
import { resolveIagMutationActionAuthority } from '@sangfor/competency';
import { parseIagMutationAction } from '../apply/iag-action-authority.js';
import type { IagExecutor } from '../apply/iag-executor.js';
import { isNarrowReversibleIagAction } from './policy.js';
import { groundIagApplyResult, type IagApplyResult, ungroundedRefusal } from './result.js';
import type { IagOrchestratorRequest } from './run-machine.js';

function digest(domain: string, value: string): string {
  return createHash('sha256').update(`${domain}\0${value}`, 'utf8').digest('hex');
}

export async function dryRunIagMutation(input: {
  readonly request: IagOrchestratorRequest;
  readonly executor: IagExecutor;
}): Promise<IagApplyResult> {
  const authority = await resolveIagMutationActionAuthority(
    input.request.authorityRequest,
    { persistStaleness: false },
  );
  const malformedRunId = digest('iag-orchestrator-malformed', input.request.actionSource);
  if (!authority.ok) return ungroundedRefusal(malformedRunId, authority.code);
  const parsed = parseIagMutationAction({
    source: input.request.actionSource,
    authority: authority.authority,
  });
  if (!parsed.ok) return ungroundedRefusal(malformedRunId, parsed.refusal.code.toUpperCase());
  const action = parsed.value;
  const runId = digest('iag-orchestrator-run', action.bindings.idempotencyKey);
  if (!action.dryRun) return groundIagApplyResult({
    runId, outcome: 'REFUSED', action, mutationAttempted: false,
    reasonCode: 'IAG_DRY_RUN_ACTION_REQUIRED',
  });
  if (!isNarrowReversibleIagAction(action)) return groundIagApplyResult({
    runId, outcome: 'REFUSED', action, mutationAttempted: false,
    reasonCode: 'BROAD_OR_IRREVERSIBLE_ACTION_REFUSED',
  });
  const preflight = await input.executor.preflight(action);
  if (preflight.status !== 'READY_TO_DISPATCH' && preflight.status !== 'NO_CHANGE_CANDIDATE') {
    return groundIagApplyResult({
      runId, outcome: 'REFUSED', action, mutationAttempted: false,
      reasonCode: preflight.reasonCode ?? `PREFLIGHT_${preflight.status}`,
    });
  }
  return groundIagApplyResult({
    runId, outcome: 'DRY_RUN_COMPLETE', action, mutationAttempted: false,
  });
}
