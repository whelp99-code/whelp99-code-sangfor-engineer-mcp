/**
 * The pre-change completeness baseline contract.
 *
 * A baseline that reports only what a run happened to reach is worse than no
 * baseline: the sources it silently skipped are exactly the ones nobody will
 * remember to re-check. So the required source set is declared here as data, an
 * omission refuses the whole report (`BASELINE_SOURCE_MISSING`), and an
 * unavailable source is recorded as FAIL/BLOCKED/NOT_RUN rather than dropped.
 * PASS is reserved for a source that was actually established, which is why a
 * missing bridge or an absent token can never round up to a green baseline.
 */
import { z } from 'zod';
import { parseRuntimeJson, type RuntimeSchemaContract } from '../../packages/shared/src/runtime-schema.js';

/**
 * The closed inventory the baseline must speak to. Each id names a question the
 * production-readiness program has to answer before it changes anything; adding
 * a question means adding it here, which fails every run that does not collect it.
 */
export const REQUIRED_BASELINE_SOURCES = [
  'workatom_coverage',
  'historical_raw_vs_grounded',
  'catalog_violations',
  'mcp_census',
  'github_program_graph',
  'active_debt',
  'persistence_cutover',
  'production_wiring',
  'test_environment_blockers',
] as const;

export type BaselineSourceId = (typeof REQUIRED_BASELINE_SOURCES)[number];

/** PASS means established. Everything else names why it was not. */
export const BASELINE_STATES = ['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN'] as const;

export type BaselineState = (typeof BASELINE_STATES)[number];

const observationSchema = z.object({
  sourceId: z.enum(REQUIRED_BASELINE_SOURCES),
  /** Where the value came from: a URL, a repo-relative path, or a fixture scheme. */
  origin: z.string().min(1),
  collectedAt: z.string().datetime(),
  /** The exact command or call that produced it, so a reader can re-run it. */
  command: z.string().min(1),
  state: z.enum(BASELINE_STATES),
  detail: z.string().min(1),
  data: z.unknown(),
});

const observationsSchema = z.array(observationSchema).readonly();

export type BaselineObservation = z.infer<typeof observationSchema>;

const OBSERVATIONS_CONTRACT: RuntimeSchemaContract<readonly BaselineObservation[]> = {
  schema: observationsSchema,
  schemaName: 'CompletenessBaselineObservations',
  policy: 'loud_failure',
};

export type BaselineViolation = {
  readonly code: 'BASELINE_SOURCE_MISSING' | 'BASELINE_SOURCE_DUPLICATED';
  readonly sourceId: BaselineSourceId;
  readonly detail: string;
};

export type Baseline = {
  /** True only when every required source is present AND every one of them is PASS. */
  readonly complete: boolean;
  readonly sources: readonly BaselineObservation[];
  readonly unavailableSources: readonly BaselineSourceId[];
};

export type BaselineAssembly =
  | { readonly ok: true; readonly baseline: Baseline }
  | { readonly ok: false; readonly violations: readonly BaselineViolation[] };

/** Untrusted collector output crosses the boundary exactly once, here. */
export function parseObservations(source: string): readonly BaselineObservation[] {
  return parseRuntimeJson(source, OBSERVATIONS_CONTRACT);
}

export function assembleBaseline(observations: readonly BaselineObservation[]): BaselineAssembly {
  const byId = new Map<BaselineSourceId, BaselineObservation>();
  const violations: BaselineViolation[] = [];

  for (const observation of observations) {
    if (byId.has(observation.sourceId)) {
      // Two observations of one source are two answers, not a newer answer.
      // Keeping the last would let a retry overwrite the failure it retried.
      violations.push({
        code: 'BASELINE_SOURCE_DUPLICATED',
        sourceId: observation.sourceId,
        detail: `source '${observation.sourceId}' was observed more than once in a single run`,
      });
      continue;
    }
    byId.set(observation.sourceId, observation);
  }

  for (const sourceId of REQUIRED_BASELINE_SOURCES) {
    if (byId.has(sourceId)) continue;
    violations.push({
      code: 'BASELINE_SOURCE_MISSING',
      sourceId,
      detail: `required source '${sourceId}' carries no observation, so the baseline cannot be trusted`,
    });
  }

  if (violations.length > 0) return { ok: false, violations };

  // Ordered by the contract, not by collection order, so two runs of the same
  // repo produce byte-identical inventories and a diff means a real change.
  const sources = REQUIRED_BASELINE_SOURCES.flatMap((id) => byId.get(id) ?? []);

  const unavailableSources = sources.filter((s) => s.state !== 'PASS').map((s) => s.sourceId);
  return {
    ok: true,
    baseline: { complete: unavailableSources.length === 0, sources, unavailableSources },
  };
}
