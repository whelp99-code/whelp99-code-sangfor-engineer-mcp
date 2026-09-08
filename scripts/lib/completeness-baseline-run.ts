/**
 * Runs every baseline collector once and hands the observations to the contract.
 *
 * Live surfaces arrive as already-run probes: this module decides what a result
 * MEANS, the caller decides how to reach the network, and neither can quietly
 * turn an unreachable surface into a PASS. Everything that can be read from the
 * repo is read here, so an omitted collector fails `assembleBaseline` instead of
 * shrinking the inventory.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { parseRuntimeJson, type RuntimeSchemaContract } from '../../packages/shared/src/runtime-schema.js';
import { assembleBaseline, type Baseline, type BaselineAssembly, type BaselineObservation } from './completeness-baseline.js';
import { collectCatalogBaseline } from './completeness-baseline-catalog.js';
import {
  collectActiveDebt,
  collectPersistenceCutover,
  collectProductionWiring,
  collectTestEnvironmentBlockers,
  fromProbe,
  observe,
  type CollectorEnvironment,
  type ProbeOutcome,
} from './completeness-baseline-sources.js';

export type CensusProbe = ProbeOutcome<{ readonly toolNames: readonly string[]; readonly origin: string }>;

export type GraphProbe = ProbeOutcome<{
  readonly reportOk: boolean;
  readonly parentIssue: number | undefined;
  readonly childIssues: readonly number[];
  readonly violations: readonly unknown[];
  readonly origin: string;
}>;

export function baselineExitCode(baseline: Baseline): 0 | 1 {
  return baseline.sources.some(
    (source) => source.sourceId === 'github_program_graph' && source.state === 'FAIL',
  ) ? 1 : 0;
}

export interface BaselineRunInput {
  readonly environment: CollectorEnvironment;
  readonly roots: { readonly catalog: string; readonly evidence: string; readonly historicalRecord: string };
  readonly probes: { readonly mcpCensus: CensusProbe; readonly githubGraph: GraphProbe };
}

const historicalRecordSchema = z.object({
  baseline: z.object({
    callerDiscrepancy: z.object({
      rawNoGrounding: z.object({
        replaced: z.literal(2),
        automatable: z.literal(16),
        total: z.literal(20).optional(),
      }),
      groundedMcp: z.object({ replaced: z.literal(1), automatable: z.literal(16) }),
    }),
  }),
});

type HistoricalRecord = z.infer<typeof historicalRecordSchema>;

const HISTORICAL_CONTRACT: RuntimeSchemaContract<HistoricalRecord> = {
  schema: historicalRecordSchema,
  schemaName: 'CompletenessHistoricalRecord',
  policy: 'loud_failure',
};

/**
 * This caller was deleted when coverage became fail-closed. The record is
 * required because it cannot be reconstructed; missing or malformed evidence
 * therefore omits the observation and lets assembly refuse the whole baseline.
 */
function historicalObservations(input: BaselineRunInput): readonly BaselineObservation[] {
  const relative = input.roots.historicalRecord;
  const path = join(input.environment.repoRoot, relative);
  if (!existsSync(path)) return [];

  let record: HistoricalRecord;
  try {
    record = parseRuntimeJson(readFileSync(path, 'utf8'), HISTORICAL_CONTRACT);
  } catch (error) {
    if (error instanceof Error) return [];
    throw error;
  }

  const { rawNoGrounding, groundedMcp } = record.baseline.callerDiscrepancy;
  return [observe(
    {
      sourceId: 'historical_raw_vs_grounded',
      origin: relative,
      command: `parse ${relative} with the CompletenessHistoricalRecord contract`,
    },
    input.environment,
    'PASS',
    'recorded pre-change discrepancy; not a claim about current coverage',
    {
      scope: 'historical_pre_change',
      current: false,
      rawNoGrounding: { replaced: rawNoGrounding.replaced, automatable: rawNoGrounding.automatable },
      groundedMcp: { replaced: groundedMcp.replaced, automatable: groundedMcp.automatable },
    },
  )];
}

function censusObservations(input: BaselineRunInput): readonly BaselineObservation[] {
  const probe = input.probes.mcpCensus;
  if (!probe.ok && probe.state === 'FAIL') return [];
  return [fromProbe(
    {
      sourceId: 'mcp_census',
      origin: probe.ok ? probe.value.origin : 'the live MCP surface',
      command: 'read tools/list from the running MCP surface',
    },
    input.environment,
    probe,
    (value) => ({
      detail: `${value.toolNames.length} tool(s) registered`,
      data: { total: value.toolNames.length, toolNames: value.toolNames },
    }),
  )];
}

function graphObservations(input: BaselineRunInput): readonly BaselineObservation[] {
  const probe = input.probes.githubGraph;
  if (!probe.ok && probe.state === 'FAIL') return [];
  const draft = {
    sourceId: 'github_program_graph',
    origin: probe.ok ? probe.value.origin : 'the live GitHub tracker',
    command: 'gh issue list / gh pr list → evaluateTrackerTruth',
  } as const;
  if (!probe.ok) return [observe(draft, input.environment, probe.state, probe.detail, null)];
  return [observe(
    draft,
    input.environment,
    probe.value.reportOk ? 'PASS' : 'FAIL',
    `parent #${String(probe.value.parentIssue)} with ${probe.value.childIssues.length} child issue(s) and ${probe.value.violations.length} violation(s)`,
    {
      parentIssue: probe.value.parentIssue,
      childIssues: probe.value.childIssues,
      violations: probe.value.violations,
    },
  )];
}

export function runBaseline(input: BaselineRunInput): BaselineAssembly {
  const { environment } = input;
  return assembleBaseline([
    ...collectCatalogBaseline({
      environment,
      catalogRoot: input.roots.catalog,
      evidenceRoot: input.roots.evidence,
      census: input.probes.mcpCensus,
    }),
    ...historicalObservations(input),
    ...censusObservations(input),
    ...graphObservations(input),
    ...[collectActiveDebt(environment)].filter((observation) => observation.data !== null),
    collectPersistenceCutover(environment),
    collectProductionWiring(environment),
    ...[collectTestEnvironmentBlockers(environment)].filter((observation) => observation.data !== null),
  ]);
}
