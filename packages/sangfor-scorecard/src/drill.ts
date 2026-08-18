/**
 * Drill mode (design 002, block G3).
 *
 * Rehearsal scenarios are data, not code: each declares the fault shape to
 * inject (into the mock console, a fixture, or a staging device) and the
 * detection outcome the pipeline must produce. `runDrill` compares what the
 * injected detectors actually reported against that expectation.
 *
 * The single rule that makes a drill worth running: a detector that misses a
 * signal produces a gap, never a `detected: true`. Silence is failure, and a
 * detector that throws is a failed rehearsal rather than a crashed process.
 */
export type DrillScenarioId = 'auth-expiry' | 'schema-drift' | 'ha-split-brain';

export interface DrillExpectation {
  /** Signals the detection pipeline must raise for this fault. */
  signals: readonly string[];
  /** Sections the escalation dossier must contain for this fault. */
  dossierSections: readonly string[];
}

export interface DrillScenario {
  id: DrillScenarioId;
  title: string;
  /** The fault injected for the rehearsal, handed verbatim to the detectors. */
  fault: Record<string, unknown>;
  expected: DrillExpectation;
}

export interface DrillDossier {
  sections: string[];
}

export interface DrillDetectors {
  detectSignals: (fault: Record<string, unknown>) => string[];
  assembleDossier: (fault: Record<string, unknown>) => DrillDossier;
}

export type DrillGap =
  | { kind: 'missed-signal'; signal: string }
  | { kind: 'missing-dossier-section'; section: string }
  | { kind: 'detector-error'; message: string };

export interface DrillResult {
  scenarioId: DrillScenarioId;
  /** True only when every expected signal was reported. */
  detected: boolean;
  dossierComplete: boolean;
  gaps: DrillGap[];
  detectedSignals: string[];
}

export const DRILL_SCENARIOS: readonly DrillScenario[] = [
  {
    id: 'auth-expiry',
    title: 'Collector credential expires mid-cycle',
    fault: { kind: 'auth-expiry', tokenExpiredAt: '2026-08-01T00:00:00.000Z', httpStatus: 401 },
    expected: {
      signals: ['collection-auth-failed', 'freshness-slo-breach'],
      dossierSections: ['timeline', 'provenance', 'recommended-action'],
    },
  },
  {
    id: 'schema-drift',
    title: 'Device API renames a field the mapper depends on',
    fault: { kind: 'schema-drift', endpoint: '/api/v1/cluster', removedField: 'mtu', addedField: 'mtuBytes' },
    expected: {
      signals: ['mapper-unmapped-field', 'corroboration-divergence'],
      dossierSections: ['timeline', 'observed-vs-expected', 'recommended-action'],
    },
  },
  {
    id: 'ha-split-brain',
    title: 'Both HA members claim the active role',
    fault: { kind: 'ha-split-brain', members: ['node-a', 'node-b'], bothActive: true },
    expected: {
      signals: ['ha-role-conflict', 'cross-device-spec-fail'],
      dossierSections: ['timeline', 'intent-graph', 'blast-radius', 'recommended-action'],
    },
  },
];

/** Look up a rehearsal scenario; an unknown id fails loud instead of silently passing. */
export function getDrillScenario(id: DrillScenarioId): DrillScenario {
  const scenario = DRILL_SCENARIOS.find((candidate) => candidate.id === id);
  if (!scenario) throw new Error(`Unknown drill scenario "${id}"`);
  return scenario;
}

function safely<T>(run: () => T, fallback: T, gaps: DrillGap[]): T {
  try {
    return run();
  } catch (error) {
    gaps.push({ kind: 'detector-error', message: error instanceof Error ? error.message : String(error) });
    return fallback;
  }
}

/**
 * Run one rehearsal against injected detectors. Extra signals a detector
 * reports are ignored — the drill asks whether the expected outcome was
 * produced, not whether the pipeline was quiet otherwise.
 */
export function runDrill(scenario: DrillScenario, detectors: DrillDetectors): DrillResult {
  const gaps: DrillGap[] = [];
  const detectedSignals = safely(() => detectors.detectSignals(scenario.fault), [], gaps);
  const dossier = safely(() => detectors.assembleDossier(scenario.fault), { sections: [] }, gaps);

  const missedSignals = scenario.expected.signals.filter((signal) => !detectedSignals.includes(signal));
  const missingSections = scenario.expected.dossierSections.filter(
    (section) => !dossier.sections.includes(section),
  );

  for (const signal of missedSignals) gaps.push({ kind: 'missed-signal', signal });
  for (const section of missingSections) gaps.push({ kind: 'missing-dossier-section', section });

  return {
    scenarioId: scenario.id,
    detected: missedSignals.length === 0,
    dossierComplete: missingSections.length === 0,
    gaps,
    detectedSignals,
  };
}
