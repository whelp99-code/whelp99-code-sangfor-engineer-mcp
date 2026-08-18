import { describe, expect, it } from 'vitest';
import {
  DRILL_SCENARIOS,
  getDrillScenario,
  runDrill,
  type DrillDetectors,
  type DrillScenario,
} from '../packages/sangfor-scorecard/src/index.js';

/** A detector set that sees everything the scenario injected. */
function perfectDetectors(scenario: DrillScenario): DrillDetectors {
  return {
    detectSignals: () => [...scenario.expected.signals],
    assembleDossier: () => ({ sections: [...scenario.expected.dossierSections] }),
  };
}

describe('@sangfor/scorecard — drill scenarios as data (design 002, block G3)', () => {
  it('declares the three rehearsal scenarios with an injected fault and an expected outcome', () => {
    expect(DRILL_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      'auth-expiry',
      'schema-drift',
      'ha-split-brain',
    ]);
    for (const scenario of DRILL_SCENARIOS) {
      expect(Object.keys(scenario.fault).length).toBeGreaterThan(0);
      expect(scenario.expected.signals.length).toBeGreaterThan(0);
      expect(scenario.expected.dossierSections.length).toBeGreaterThan(0);
    }
  });

  it('describes auth-expiry as an injected credential fault detected by an auth signal', () => {
    const scenario = getDrillScenario('auth-expiry');
    expect(scenario.fault).toEqual({ kind: 'auth-expiry', tokenExpiredAt: '2026-08-01T00:00:00.000Z', httpStatus: 401 });
    expect(scenario.expected.signals).toContain('collection-auth-failed');
  });

  it('throws on an unknown scenario id rather than inventing a rehearsal', () => {
    expect(() => getDrillScenario('meteor-strike' as never)).toThrow(/meteor-strike/);
  });
});

describe('@sangfor/scorecard — runDrill', () => {
  it('reports a full pass when every expected signal is detected and the dossier is complete', () => {
    const scenario = getDrillScenario('schema-drift');
    const result = runDrill(scenario, perfectDetectors(scenario));

    expect(result).toEqual({
      scenarioId: 'schema-drift',
      detected: true,
      dossierComplete: true,
      gaps: [],
      detectedSignals: [...scenario.expected.signals],
    });
  });

  it('never claims detection when a detector misses a signal — the miss is listed as a gap', () => {
    const scenario = getDrillScenario('ha-split-brain');
    const missed = scenario.expected.signals[0];
    const detectors: DrillDetectors = {
      detectSignals: () => scenario.expected.signals.filter((signal) => signal !== missed),
      assembleDossier: () => ({ sections: [...scenario.expected.dossierSections] }),
    };

    const result = runDrill(scenario, detectors);
    expect(result.detected).toBe(false);
    expect(result.gaps).toEqual([{ kind: 'missed-signal', signal: missed }]);
    expect(result.detectedSignals).not.toContain(missed);
  });

  it('reports a silent detector as every signal missed, never as detected', () => {
    const scenario = getDrillScenario('auth-expiry');
    const result = runDrill(scenario, {
      detectSignals: () => [],
      assembleDossier: () => ({ sections: [] }),
    });

    expect(result.detected).toBe(false);
    expect(result.dossierComplete).toBe(false);
    expect(result.gaps).toEqual([
      ...scenario.expected.signals.map((signal) => ({ kind: 'missed-signal', signal })),
      ...scenario.expected.dossierSections.map((section) => ({ kind: 'missing-dossier-section', section })),
    ]);
  });

  it('flags an incomplete dossier even when detection succeeded', () => {
    const scenario = getDrillScenario('schema-drift');
    const dropped = scenario.expected.dossierSections[0];
    const result = runDrill(scenario, {
      detectSignals: () => [...scenario.expected.signals],
      assembleDossier: () => ({ sections: scenario.expected.dossierSections.filter((s) => s !== dropped) }),
    });

    expect(result.detected).toBe(true);
    expect(result.dossierComplete).toBe(false);
    expect(result.gaps).toEqual([{ kind: 'missing-dossier-section', section: dropped }]);
  });

  it('treats a detector that throws as a failed rehearsal, not a crashed run', () => {
    const scenario = getDrillScenario('auth-expiry');
    const result = runDrill(scenario, {
      detectSignals: () => { throw new Error('transport exploded'); },
      assembleDossier: () => ({ sections: [...scenario.expected.dossierSections] }),
    });

    expect(result.detected).toBe(false);
    expect(result.gaps).toContainEqual({ kind: 'detector-error', message: 'transport exploded' });
  });

  it('ignores extra signals a detector reports beyond the scenario expectation', () => {
    const scenario = getDrillScenario('auth-expiry');
    const result = runDrill(scenario, {
      detectSignals: () => [...scenario.expected.signals, 'unrelated-noise'],
      assembleDossier: () => ({ sections: [...scenario.expected.dossierSections] }),
    });

    expect(result.detected).toBe(true);
    expect(result.gaps).toEqual([]);
  });

  it('passes the scenario fault to the detector so a rehearsal exercises the injected shape', () => {
    const scenario = getDrillScenario('ha-split-brain');
    const seen: Array<Record<string, unknown>> = [];
    runDrill(scenario, {
      detectSignals: (fault) => { seen.push(fault); return [...scenario.expected.signals]; },
      assembleDossier: (fault) => { seen.push(fault); return { sections: [...scenario.expected.dossierSections] }; },
    });

    expect(seen).toEqual([scenario.fault, scenario.fault]);
  });
});
