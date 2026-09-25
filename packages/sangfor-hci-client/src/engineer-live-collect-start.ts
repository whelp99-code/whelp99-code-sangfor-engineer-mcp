/**
 * E12 live-collect start. Evaluates Jae-owned intake and refuses before
 * any client/fetch call. This increment does not GET, even when intake
 * is complete. It does not grant `field_accepted` or start apply/E14.
 */

import {
  evaluateEngineerLiveCollectStart,
  type EngineerLiveCollectIntake,
  type EngineerLiveCollectStartRefusal,
} from '../../shared/src/engineer-live-collect-intake.js';

export type EngineerLiveCollectStartInput = {
  readonly intake?: EngineerLiveCollectIntake;
  readonly collect?: (...args: never[]) => Promise<unknown>;
  readonly fetch?: typeof fetch;
};

export async function startEngineerLiveCollect(
  input: EngineerLiveCollectStartInput = {},
): Promise<EngineerLiveCollectStartRefusal> {
  const gate = evaluateEngineerLiveCollectStart(input.intake);
  if (!gate.ok) return gate;
  return {
    ok: false,
    fieldAccepted: false,
    grantPath: 'none',
    liveRead: 'not_run',
    collectExecuted: false,
    networkContacted: false,
    reasonCode: 'LIVE_COLLECT_INTAKE_COMPLETE_NOT_STARTED',
    missingFields: [],
    mutationDispatchCount: 0,
  };
}
