import type { IagApplyResult } from './result.js';
import type { FileIagOrchestratorStore } from './store.js';

const RUN_ID = /^[a-f0-9]{64}$/u;

export function lookupIagRunStatus(
  store: FileIagOrchestratorStore,
  runId: string,
): IagApplyResult {
  if (!RUN_ID.test(runId)) throw new TypeError('IAG_RUN_ID_INVALID');
  const record = store.read(runId, true);
  if (record.terminal !== undefined) return record.terminal;
  const mutationAttempted = record.events.some(({ state }) => (
    state === 'DISPATCHING' || state === 'VERIFYING'
  ));
  return {
    runId,
    outcome: 'INDETERMINATE',
    actionDigest: record.requestDigest,
    mutationAttempted,
    retryCount: 0,
    promotionEligible: false,
    verifiedSuccess: false,
    finalReadBack: 'UNAVAILABLE',
    reasonCode: 'RUN_NOT_TERMINAL',
  };
}
