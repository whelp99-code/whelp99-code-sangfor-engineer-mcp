import { describe, expect, it } from 'vitest';
import { assessHciCapacityOrHaFromInventory, summarizeHciHealth } from '../packages/sangfor-hci-client/src/ops-monitor.js';
import { assembleEngineerCase } from '../packages/sangfor-planner/src/engineer-case.js';
import {
  ENGINEER_CASE_SCHEMA_VERSION,
  serializeEngineerValue,
  type EngineerCaseDocument,
  type EngineerUnit,
} from '../packages/shared/src/engineer-case-contract.js';
import { evaluateDerivedFitness, evaluateSpec } from '../packages/sangfor-spec/src/index.js';
import {
  ENGINEER_FORMULA_CATALOG,
  convertEngineerUnit,
  evaluateEngineerFormula,
  evaluateUnsupportedHaCapacity,
  recommendSizing,
  sizingTierIsNotOfficialFormula,
  type EngineerFormulaOperand,
  type EngineerFormulaRequest,
} from '../packages/sangfor-sizing/src/index.js';

const AUTH = { tenantId: 'tenant-a', projectId: 'proj-a', actorId: 'actor-a' } as const;
const DIGEST = 'ab'.repeat(32);
const WHEN = '2026-09-09T00:00:00.000Z';
const LATER = '2026-09-10T00:00:00.000Z';

/**
 * Independent hand oracles. These numbers were computed outside the formula
 * implementation and must stay literal.
 */
const ORACLE = {
  remainingSameGiB: 60,
  remainingTibMinusGib: 0.75,
  remainingGbMinusMb: 0.9,
  remainingZero: 0,
  remainingExceeded: -2,
  remainingGbVsGib: -0.073741824,
  utilizationSameGiB: 40,
  utilizationTib: 25,
  utilizationZero: 0,
  utilizationGbVsGib: 107.374182,
  headroomAfterDemand: 40,
} as const;

function quantity(
  id: string,
  number: number,
  unit: EngineerUnit,
  extras: Partial<EngineerFormulaOperand> = {},
): EngineerFormulaOperand {
  return {
    id,
    sourceKind: extras.sourceKind ?? 'provided',
    collectionStatus: extras.collectionStatus ?? 'complete',
    collectedAt: extras.collectedAt ?? WHEN,
    freshnessPolicy: extras.freshnessPolicy,
    unavailableReason: extras.unavailableReason,
    value: extras.value ?? { presence: 'known', data: { kind: 'number', number, unit } },
  };
}

function request(
  formulaId: EngineerFormulaRequest['formulaId'],
  roles: EngineerFormulaRequest['roles'],
  extras: Partial<EngineerFormulaRequest> = {},
): EngineerFormulaRequest {
  return { id: `calc-${formulaId}`, formulaId, roles, ...extras };
}

function validFixtureCase(overrides: Record<string, unknown> = {}): EngineerCaseDocument {
  return {
    schemaVersion: ENGINEER_CASE_SCHEMA_VERSION,
    caseId: 'case-existing-1',
    mode: 'existing',
    product: 'HCI_SCP',
    revision: 'rev-1',
    progress: 'draft',
    environmentKind: 'fixture',
    synthetic: true,
    originalPresent: false,
    observations: [
      {
        id: 'obs-total',
        sourceKind: 'provided',
        collectionStatus: 'complete',
        collectedAt: WHEN,
        value: { presence: 'known', data: { kind: 'number', number: 100, unit: 'GiB' } },
      },
      {
        id: 'obs-used',
        sourceKind: 'provided',
        collectionStatus: 'complete',
        collectedAt: WHEN,
        value: { presence: 'known', data: { kind: 'number', number: 40, unit: 'GiB' } },
      },
    ],
    requirements: [{
      id: 'req-headroom',
      sourceKind: 'provided',
      sourceRef: 'excel-row-1',
      constraint: 'headroom >= 20 percent',
      priority: 'high',
      confirmationState: 'unconfirmed',
      acceptanceCriterion: 'usable headroom remains above 20 percent',
      revision: 'req-rev-1',
    }],
    calculations: [{
      id: 'calc-remaining',
      sourceKind: 'derived',
      formulaId: 'confirmed-remaining-capacity',
      formulaVersion: '1.0.0',
      inputRefs: ['obs-total', 'obs-used'],
      assumptions: ['usable capacity is the provided fixture value'],
      result: { presence: 'known', data: { kind: 'number', number: 0, unit: 'GiB' } },
    }],
    assessments: [{
      id: 'assess-headroom',
      requirementRef: 'req-headroom',
      currentRef: 'obs-total',
      calculationRefs: ['calc-remaining'],
      status: 'unresolved',
      reasons: ['usable capacity is provided, not observed'],
      nextAction: 'recollect',
    }],
    guide: {
      revision: 'guide-rev-1',
      digest: DIGEST,
      requirementRefs: ['req-headroom'],
      steps: [{
        id: 'step-confirm',
        order: 1,
        title: 'Confirm usable capacity',
        requirementRefs: ['req-headroom'],
        currentRef: 'obs-total',
        evidenceRefs: ['ev-1'],
        citations: [],
        verify: 'Re-read usable capacity from the approved surface',
        stop: 'Stop if the value is unknown',
        recovery: 'Leave the case blocked and ask PM',
      }],
      prerequisites: [],
      unresolved: ['usable capacity is provided, not observed'],
      readiness: 'review_ready',
    },
    evidence: [{
      id: 'ev-1',
      digest: DIGEST,
      mediaType: 'application/json',
      sanitized: true,
      retention: 'case-revision',
    }],
    execution: { result: 'not_started' },
    ...overrides,
  } as EngineerCaseDocument;
}

describe('engineer formula catalog', () => {
  it('documents unit, zero, rounding, negative, overflow, and stale rules for each formula', () => {
    expect(Object.keys(ENGINEER_FORMULA_CATALOG)).toEqual([
      'confirmed-remaining-capacity',
      'confirmed-utilization-ratio',
      'demand-headroom',
    ]);
    for (const formula of Object.values(ENGINEER_FORMULA_CATALOG)) {
      expect(formula.version).toBe('1.0.0');
      expect(formula.units).toMatch(/GiB/);
      expect(formula.zeroDenominator.length).toBeGreaterThan(0);
      expect(formula.rounding).toMatch(/half-away-from-zero/);
      expect(formula.negativeInputs).toMatch(/NEGATIVE_INPUT/);
      expect(formula.stalePartial).toMatch(/unavailable/);
    }
  });
});

describe('confirmed-remaining-capacity', () => {
  it('matches the hand oracle for same-unit, mixed IEC, mixed SI, zero, and exceeded inputs', () => {
    const same = evaluateEngineerFormula(request('confirmed-remaining-capacity', {
      total: quantity('obs-total', 100, 'GiB'),
      used: quantity('obs-used', 40, 'GiB'),
    }));
    expect(same).toMatchObject({
      sourceKind: 'derived',
      formulaId: 'confirmed-remaining-capacity',
      formulaVersion: '1.0.0',
      inputRefs: ['obs-total', 'obs-used'],
      result: { presence: 'known', data: { kind: 'number', number: ORACLE.remainingSameGiB, unit: 'GiB' } },
    });

    const mixedIec = evaluateEngineerFormula(request('confirmed-remaining-capacity', {
      total: quantity('obs-total', 1, 'TiB'),
      used: quantity('obs-used', 256, 'GiB'),
    }));
    expect(mixedIec.result).toEqual({
      presence: 'known',
      data: { kind: 'number', number: ORACLE.remainingTibMinusGib, unit: 'TiB' },
    });

    const mixedSi = evaluateEngineerFormula(request('confirmed-remaining-capacity', {
      total: quantity('obs-total', 1, 'GB'),
      used: quantity('obs-used', 100, 'MB'),
    }));
    expect(mixedSi.result).toEqual({
      presence: 'known',
      data: { kind: 'number', number: ORACLE.remainingGbMinusMb, unit: 'GB' },
    });

    const zero = evaluateEngineerFormula(request('confirmed-remaining-capacity', {
      total: quantity('obs-total', 40, 'GiB'),
      used: quantity('obs-used', 40, 'GiB'),
    }));
    expect(zero.sourceKind).toBe('derived');
    expect(zero.result).toEqual({
      presence: 'known',
      data: { kind: 'number', number: ORACLE.remainingZero, unit: 'GiB' },
    });
    expect(serializeEngineerValue(zero.result!).value).toEqual({ kind: 'number', number: 0, unit: 'GiB' });

    const exceeded = evaluateEngineerFormula(request('confirmed-remaining-capacity', {
      total: quantity('obs-total', 10, 'GiB'),
      used: quantity('obs-used', 12, 'GiB'),
    }));
    expect(exceeded.result).toEqual({
      presence: 'known',
      data: { kind: 'number', number: ORACLE.remainingExceeded, unit: 'GiB' },
    });
    expect(exceeded.assumptions.some((item) => item.startsWith('used-exceeds-total'))).toBe(true);
  });

  it('converts GB versus GiB instead of treating them as equal', () => {
    const mixed = evaluateEngineerFormula(request('confirmed-remaining-capacity', {
      total: quantity('obs-total', 1, 'GB'),
      used: quantity('obs-used', 1, 'GiB'),
    }));
    const converted = convertEngineerUnit(1, 'GiB', 'GB');
    expect(converted.ok).toBe(true);
    if (!converted.ok) throw new Error('expected conversion');
    expect(converted.converted).toBe(true);
    expect(converted.value).not.toBe(1);
    expect(Number(converted.value.toFixed(9))).toBe(1.073741824);
    expect(mixed.result).toEqual({
      presence: 'known',
      data: { kind: 'number', number: ORACLE.remainingGbVsGib, unit: 'GB' },
    });
  });

  it('refuses a missing required input and names the formula plus missing role', () => {
    const missing = evaluateEngineerFormula(request('confirmed-remaining-capacity', {
      total: quantity('obs-total', 100, 'GiB'),
    }));
    expect(missing.sourceKind).toBe('unknown');
    expect(missing.formulaId).toBe('confirmed-remaining-capacity');
    expect(missing.formulaVersion).toBe('1.0.0');
    expect(missing.unavailableReason).toBe('MISSING_INPUTS:used');
    expect(missing.result).toEqual({ presence: 'unknown', reason: 'MISSING_INPUTS:used' });
  });

  it('refuses incompatible dimensions instead of fabricating a remaining value', () => {
    const mixed = evaluateEngineerFormula(request('confirmed-remaining-capacity', {
      total: quantity('obs-total', 10, 'GiB'),
      used: quantity('obs-used', 3, 'VMs'),
    }));
    expect(mixed.sourceKind).toBe('unknown');
    expect(mixed.unavailableReason).toBe('UNIT_INCOMPATIBLE:obs-used');
  });
});

describe('confirmed-utilization-ratio', () => {
  it('matches the hand oracle and keeps a derived zero distinct from unknown', () => {
    const same = evaluateEngineerFormula(request('confirmed-utilization-ratio', {
      total: quantity('obs-total', 100, 'GiB'),
      used: quantity('obs-used', 40, 'GiB'),
    }));
    expect(same.result).toEqual({
      presence: 'known',
      data: { kind: 'number', number: ORACLE.utilizationSameGiB, unit: 'percent' },
    });

    const mixed = evaluateEngineerFormula(request('confirmed-utilization-ratio', {
      total: quantity('obs-total', 1, 'TiB'),
      used: quantity('obs-used', 256, 'GiB'),
    }));
    expect(mixed.result).toEqual({
      presence: 'known',
      data: { kind: 'number', number: ORACLE.utilizationTib, unit: 'percent' },
    });

    const zero = evaluateEngineerFormula(request('confirmed-utilization-ratio', {
      total: quantity('obs-total', 100, 'GiB'),
      used: quantity('obs-used', 0, 'GiB'),
    }));
    expect(zero.sourceKind).toBe('derived');
    expect(zero.result).toEqual({
      presence: 'known',
      data: { kind: 'number', number: ORACLE.utilizationZero, unit: 'percent' },
    });
  });

  it('refuses a zero denominator and does not emit Infinity', () => {
    const zeroTotal = evaluateEngineerFormula(request('confirmed-utilization-ratio', {
      total: quantity('obs-total', 0, 'GiB'),
      used: quantity('obs-used', 10, 'GiB'),
    }));
    expect(zeroTotal.sourceKind).toBe('unknown');
    expect(zeroTotal.unavailableReason).toBe('DIVISION_BY_ZERO:obs-total');
    expect(zeroTotal.result?.presence).toBe('unknown');

    const bothZero = evaluateEngineerFormula(request('confirmed-utilization-ratio', {
      total: quantity('obs-total', 0, 'GiB'),
      used: quantity('obs-used', 0, 'GiB'),
    }));
    expect(bothZero.unavailableReason).toBe('DIVISION_BY_ZERO:obs-total');
  });
});

describe('demand-headroom', () => {
  it('matches the hand oracle and refuses a percent demand against capacity', () => {
    const headroom = evaluateEngineerFormula(request('demand-headroom', {
      total: quantity('obs-total', 100, 'GiB'),
      used: quantity('obs-used', 40, 'GiB'),
      demand: quantity('obs-demand', 20, 'GiB'),
    }));
    expect(headroom.result).toEqual({
      presence: 'known',
      data: { kind: 'number', number: ORACLE.headroomAfterDemand, unit: 'GiB' },
    });

    const percentDemand = evaluateEngineerFormula(request('demand-headroom', {
      total: quantity('obs-total', 100, 'GiB'),
      used: quantity('obs-used', 40, 'GiB'),
      demand: quantity('obs-demand', 20, 'percent'),
    }));
    expect(percentDemand.sourceKind).toBe('unknown');
    expect(percentDemand.unavailableReason).toBe('UNIT_INCOMPATIBLE:obs-demand');
  });

  it('refuses when any required input is missing, including E00 usable capacity', () => {
    const existingCase = evaluateEngineerFormula(request('demand-headroom', {
      used: quantity('obs-volume-size', 100, 'GB'),
    }));
    expect(existingCase.unavailableReason).toBe('MISSING_INPUTS:total,demand');
    expect(existingCase.formulaId).toBe('demand-headroom');
    expect(existingCase.formulaVersion).toBe('1.0.0');
  });
});

describe('invalid, stale, and incomplete inputs', () => {
  it('refuses 0/negative/NaN/Infinity/overflow instead of coercing them', () => {
    expect(evaluateEngineerFormula(request('confirmed-remaining-capacity', {
      total: quantity('obs-total', -1, 'GiB'),
      used: quantity('obs-used', 1, 'GiB'),
    })).unavailableReason).toBe('NEGATIVE_INPUT:obs-total');

    expect(evaluateEngineerFormula(request('confirmed-remaining-capacity', {
      total: quantity('obs-total', Number.NaN, 'GiB'),
      used: quantity('obs-used', 1, 'GiB'),
    })).unavailableReason).toBe('INVALID_NUMBER:obs-total');

    expect(evaluateEngineerFormula(request('confirmed-remaining-capacity', {
      total: quantity('obs-total', Number.POSITIVE_INFINITY, 'GiB'),
      used: quantity('obs-used', 1, 'GiB'),
    })).unavailableReason).toBe('INVALID_NUMBER:obs-total');

    expect(convertEngineerUnit(10000, 'TiB', 'B')).toEqual({ ok: false, reason: 'OVERFLOW' });
    expect(evaluateEngineerFormula(request('confirmed-remaining-capacity', {
      total: quantity('obs-total', 10000, 'TiB'),
      used: quantity('obs-used', 1, 'B'),
    }, { outputUnit: 'B' })).unavailableReason).toBe('OVERFLOW:obs-total');
  });

  it('does not calculate stale or partial observations as latest complete values', () => {
    const partial = evaluateEngineerFormula(request('confirmed-remaining-capacity', {
      total: quantity('obs-total', 100, 'GiB'),
      used: quantity('obs-used', 40, 'GiB', { collectionStatus: 'partial' }),
    }));
    expect(partial.sourceKind).toBe('unknown');
    expect(partial.unavailableReason).toBe('INCOMPLETE_INPUT:obs-used:partial');

    const stale = evaluateEngineerFormula(request('confirmed-utilization-ratio', {
      total: quantity('obs-total', 100, 'GiB', { freshnessPolicy: { maxAgeSec: 60 } }),
      used: quantity('obs-used', 40, 'GiB'),
    }, { now: LATER }));
    expect(stale.unavailableReason).toBe('STALE_INPUT:obs-total');

    const missingCollection = evaluateEngineerFormula(request('confirmed-remaining-capacity', {
      total: quantity('obs-total', 100, 'GiB', { collectionStatus: 'missing' }),
      used: quantity('obs-used', 40, 'GiB'),
    }));
    expect(missingCollection.unavailableReason).toBe('INCOMPLETE_INPUT:obs-total:missing');
  });

  it('does not treat an unknown value as 0 or PASS', () => {
    const unknown = evaluateEngineerFormula(request('confirmed-remaining-capacity', {
      total: quantity('obs-total', 100, 'GiB'),
      used: {
        id: 'obs-used',
        sourceKind: 'unknown',
        collectionStatus: 'missing',
        unavailableReason: 'usable capacity is not collected',
        value: { presence: 'unknown', reason: 'usable capacity is not collected' },
      },
    }));
    expect(unknown.sourceKind).toBe('unknown');
    expect(unknown.unavailableReason).toBe('MISSING_INPUTS:used');
    expect(serializeEngineerValue(unknown.result!).value).toBeNull();
    expect(serializeEngineerValue(unknown.result!).value).not.toBe(0);
    expect(serializeEngineerValue(unknown.result!).value).not.toBe('PASS');
  });
});

describe('determinism and version binding', () => {
  it('returns the same result for the same input and formula version', () => {
    const input = request('demand-headroom', {
      total: quantity('obs-total', 1, 'TiB'),
      used: quantity('obs-used', 256, 'GiB'),
      demand: quantity('obs-demand', 0.1, 'TiB'),
    });
    expect(evaluateEngineerFormula(input)).toEqual(evaluateEngineerFormula(input));
    expect(evaluateEngineerFormula({
      ...input,
      formulaVersion: '0.9.0',
    }).unavailableReason).toBe('UNSUPPORTED_FORMULA_VERSION:demand-headroom:0.9.0');
  });
});

describe('HA, VM count, and advisory sizing', () => {
  it('refuses HA/capacity fitness from VM or node count alone', () => {
    const ha = evaluateUnsupportedHaCapacity({
      id: 'calc-ha',
      vmCount: quantity('obs-vms', 200, 'VMs'),
      nodeCount: quantity('obs-nodes', 3, 'nodes'),
      officialTopology: undefined,
      officialFormulaCitation: undefined,
    });
    expect(ha.sourceKind).toBe('unknown');
    expect(ha.formulaId).toBe('ha-n-plus-one-capacity');
    expect(ha.unavailableReason).toMatch(/UNSUPPORTED_HA_FORMULA/);
    expect(evaluateDerivedFitness({ calculation: ha })).toMatchObject({
      verdict: 'INDETERMINATE',
      reasonCode: 'VM_COUNT_NOT_CAPACITY_OR_HA',
      guideReadyGranted: false,
    });
  });

  it('keeps recommendSizing advisory and refuses capacity PASS from HCI vmCount', () => {
    const sizing = recommendSizing('HCI', { vmCount: 200 });
    expect(sizing.advisory).toBe(true);
    expect(sizingTierIsNotOfficialFormula(sizing)).toMatchObject({
      advisory: true,
      officialBom: false,
      fitnessVerdict: 'INDETERMINATE',
      guideReadyGranted: false,
    });
  });

  it('keeps volume-status PASS from becoming a capacity or HA PASS', () => {
    const inventory = {
      volumes: [{ id: 'vol-1', name: 'data', status: 'available', size: 100, description: null }],
      servers: [{ id: 'srv-1' }],
      images: [],
      collection: {
        volumes: { status: 'complete' as const },
        servers: { status: 'complete' as const },
        images: { status: 'complete' as const },
      },
      collectedAt: WHEN,
    };
    const health = summarizeHciHealth(inventory);
    expect(health.verdict).toBe('PASS');
    expect(health.scope).toBe('volume-status');
    expect(assessHciCapacityOrHaFromInventory(inventory)).toMatchObject({
      verdict: 'INDETERMINATE',
      scope: 'capacity-or-ha',
      guideReadyGranted: false,
    });
  });
});

describe('derived fitness and guide readiness', () => {
  it('does not grant suitability PASS without a sourced baseline', () => {
    const remaining = evaluateEngineerFormula(request('confirmed-remaining-capacity', {
      total: quantity('obs-total', 100, 'GiB'),
      used: quantity('obs-used', 40, 'GiB'),
    }));
    expect(evaluateDerivedFitness({ calculation: remaining })).toMatchObject({
      verdict: 'INDETERMINATE',
      reasonCode: 'BASELINE_SOURCE_MISSING',
      guideReadyGranted: false,
    });
    expect(evaluateDerivedFitness({
      calculation: remaining,
      baseline: { source: ' ', op: 'gte', threshold: 20, unit: 'GiB' },
    }).reasonCode).toBe('BASELINE_SOURCE_MISSING');
  });

  it('can PASS only against a sourced baseline and still does not grant guide ready', () => {
    const remaining = evaluateEngineerFormula(request('confirmed-remaining-capacity', {
      total: quantity('obs-total', 100, 'GiB'),
      used: quantity('obs-used', 40, 'GiB'),
    }));
    const fitness = evaluateDerivedFitness({
      calculation: remaining,
      baseline: {
        source: 'HCI sizing guide table 4',
        sourceUrl: 'https://example.invalid/sizing',
        op: 'gte',
        threshold: 20,
        unit: 'GiB',
      },
    });
    expect(fitness).toMatchObject({
      verdict: 'PASS',
      reasonCode: 'CONFIRMED_PASS',
      guideReadyGranted: false,
    });
  });

  it('does not grant guide ready from a derived zero assembled into a fixture case', () => {
    const remaining = evaluateEngineerFormula(request('confirmed-remaining-capacity', {
      total: quantity('obs-total', 40, 'GiB'),
      used: quantity('obs-used', 40, 'GiB'),
    }));
    const assembled = assembleEngineerCase(validFixtureCase({
      calculations: [{
        id: 'calc-remaining',
        sourceKind: remaining.sourceKind,
        formulaId: remaining.formulaId,
        formulaVersion: remaining.formulaVersion,
        inputRefs: remaining.inputRefs,
        assumptions: remaining.assumptions,
        result: remaining.result,
      }],
    }), AUTH);
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) throw new Error('expected ok');
    expect(assembled.guideReadyGranted).toBe(false);
    expect(assembled.value.guide.readiness).toBe('blocked');
    expect(assembled.value.calculations[0]?.result).toEqual({
      presence: 'known',
      data: { kind: 'number', number: 0, unit: 'GiB' },
    });
  });

  it('keeps evaluateSpec from turning a missing sourced MUST item into PASS', () => {
    const result = evaluateSpec({
      id: 'capacity-fit',
      product: 'HCI',
      items: [{
        id: 'usable-headroom',
        capabilityId: 'capacity',
        label: 'Usable headroom',
        observedKey: 'capacity.headroom',
        op: 'gte',
        expected: 20,
        severity: 'must',
      }],
    }, { 'capacity.headroom': 60 });
    expect(result.items[0]?.verdict).toBe('INDETERMINATE');
    expect(result.ok).toBe(false);
  });
});
