import { describe, expect, it } from 'vitest';
import {
  resolveWriteEligibility,
  type ActiveWriteEvidence,
  type OrdinaryWriteEligibilityInput,
} from '../packages/sangfor-safety/src/index.js';

const scope = {
  product: 'HCI_SCP',
  capabilityId: 'volume_create',
  deviceId: 'device-1',
  firmwareId: 'firmware-1',
  windowId: 'window-1',
  sessionId: 'session-1',
  originId: 'origin-1',
  campaignId: 'campaign-1',
} as const;

const activeEvidence = {
  status: 'active',
  scope,
} satisfies ActiveWriteEvidence;

const ordinary = {
  kind: 'ordinary',
  target: 'non_loopback',
  scope,
  allowRealExecution: true,
  allowProductionExecution: true,
  safety: {
    safetyClass: 'auto_allowed',
    maturity: 'field_verified',
    autoAllowed: true,
    fieldVerifiedAutoAllowed: true,
  },
  evidence: activeEvidence,
} satisfies OrdinaryWriteEligibilityInput;

describe('ordinary write eligibility', () => {
  it('Given exact active evidence, When ordinary eligibility resolves, Then live execution reaches dispatch once', () => {
    let dispatchCount = 0;
    const result = resolveWriteEligibility(ordinary);
    if (result.kind === 'NORMAL_ACTIVE_EVIDENCE' && result.executionClass === 'ordinary_live') dispatchCount += 1;

    expect(result).toEqual({
      kind: 'NORMAL_ACTIVE_EVIDENCE',
      executionClass: 'ordinary_live',
      promotionEligible: true,
    });
    expect(dispatchCount).toBe(1);
  });

  const refusals = [
    ['planned maturity', { ...ordinary, safety: { ...ordinary.safety, maturity: 'planned', fieldVerifiedAutoAllowed: false } }],
    ['mock maturity', { ...ordinary, safety: { ...ordinary.safety, maturity: 'tested_mock', fieldVerifiedAutoAllowed: false } }],
    ['stale evidence', { ...ordinary, evidence: { status: 'stale' } }],
    ['invalid evidence', { ...ordinary, evidence: { status: 'refused' } }],
    ['missing evidence', { ...ordinary, evidence: { status: 'unavailable' } }],
    ['scope widening', { ...ordinary, scope: { ...scope, deviceId: 'device-2' } }],
  ] satisfies readonly (readonly [string, OrdinaryWriteEligibilityInput])[];

  it.each(refusals)('Given auto_allowed with %s, When eligibility resolves, Then it refuses', (_name, input) => {
    expect(resolveWriteEligibility(input)).toMatchObject({ kind: 'REFUSED' });
  });

  it('Given a loopback rehearsal, When eligibility resolves, Then it remains mock-only without field evidence', () => {
    expect(resolveWriteEligibility({ ...ordinary, target: 'loopback', evidence: { status: 'unavailable' } })).toEqual({
      kind: 'NORMAL_ACTIVE_EVIDENCE',
      executionClass: 'mock_only',
      promotionEligible: false,
    });
  });
});
