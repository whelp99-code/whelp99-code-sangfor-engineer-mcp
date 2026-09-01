/**
 * End-to-end baseline capture against a fixture repo.
 *
 * The point of these tests is the seam between "a source could not be read" and
 * "a source was read and says zero". A run that turns the first into the second
 * produces a confident, wrong baseline, which is the exact failure the whole
 * artifact exists to prevent.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REQUIRED_BASELINE_SOURCES } from '../scripts/lib/completeness-baseline.js';
import { baselineExitCode, runBaseline, type CensusProbe, type GraphProbe } from '../scripts/lib/completeness-baseline-run.js';
import { evaluateTrackerTruth, parseTrackerSnapshot } from '../scripts/lib/tracker-truth.js';

const COLLECTED_AT = '2026-08-26T06:00:00.000Z';
const HISTORICAL_RECORD = '.omo/evidence/task-2.json';
const TOOL = 'sangfor_evaluate_config';
const roots: string[] = [];

const CATALOG = {
  version: 1,
  atoms: [
    {
      id: 'op_daily_health',
      product: 'epp',
      phase: 'operate',
      title: 'daily health check',
      automatability: 'auto',
      coveredBy: TOOL,
      maturity: 'field_verified',
      evidence: 'outputs/health.md',
      capabilityRef: { product: 'epp', capabilityId: 'health' },
    },
    {
      id: 'handover_signoff',
      product: 'epp',
      phase: 'handover',
      title: 'customer sign-off',
      automatability: 'human',
      humanReason: 'a signature is a human act',
      maturity: 'planned',
    },
  ],
} as const;

const POLICY = {
  version: 1,
  entries: [{ product: 'epp', capabilityId: 'health', maturity: 'field_verified', evidence: 'outputs/health.md' }],
} as const;

function fixtureRepo(overrides: Readonly<Record<string, string>> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'baseline-run-'));
  roots.push(root);
  const files: Record<string, string> = {
    'data/competency/work-atoms.json': JSON.stringify(CATALOG),
    'data/competency/capability-maturity.json': JSON.stringify(POLICY),
    'outputs/health.md': '# health\n',
    'docs/plans/work/tech-debt-tracker.md': '## Open\n### #1 — the apply path is inert\n',
    'tests/gated.test.ts': "describe.skipIf(!officeCli)('office', () => {});",
    [HISTORICAL_RECORD]: JSON.stringify({
      baseline: { callerDiscrepancy: { rawNoGrounding: { replaced: 2, automatable: 16 }, groundedMcp: { replaced: 1, automatable: 16 } } },
    }),
    ...overrides,
  };
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }
  return root;
}

const LIVE_CENSUS: CensusProbe = { ok: true, value: { toolNames: [TOOL], origin: 'http://127.0.0.1:3600/tools' } };
const LIVE_GRAPH: GraphProbe = {
  ok: true,
  value: { reportOk: true, parentIssue: 30, childIssues: [31, 32], violations: [], origin: 'gh://fixture' },
};

function capture(root: string, probes: { mcpCensus: CensusProbe; githubGraph: GraphProbe }) {
  return runBaseline({
    environment: { repoRoot: root, collectedAt: COLLECTED_AT, env: {} },
    roots: {
      catalog: join(root, 'data/competency'),
      evidence: root,
      historicalRecord: HISTORICAL_RECORD,
    },
    probes,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('runBaseline — every declared source is answered', () => {
  it('inventories all required sources in contract order on a fully readable repo', () => {
    // Given a repo where every source is present and both live probes succeeded
    const root = fixtureRepo();

    // When the baseline is captured
    const result = capture(root, { mcpCensus: LIVE_CENSUS, githubGraph: LIVE_GRAPH });

    // Then every required source is present, in contract order
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.baseline.sources.map((s) => s.sourceId)).toEqual([...REQUIRED_BASELINE_SOURCES]);
  });

  it('records claimed atoms and grounded coverage as two separate facts', () => {
    // Given a catalog whose single field_verified claim is fully grounded
    const root = fixtureRepo();

    // When the baseline is captured
    const result = capture(root, { mcpCensus: LIVE_CENSUS, githubGraph: LIVE_GRAPH });

    // Then the claim inventory and the effective rate are both recorded
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const coverage = result.baseline.sources.find((s) => s.sourceId === 'workatom_coverage');
    expect(coverage?.state).toBe('PASS');
    expect(coverage?.data).toMatchObject({
      claims: { totalAtoms: 2, automatableAtoms: 1, humanOnlyAtoms: 1, fieldVerifiedClaims: ['op_daily_health'] },
      effective: { replacedAtoms: 1, automatableAtoms: 1, replacementRate: 1 },
    });
  });
});

describe('runBaseline — an unreachable surface never becomes a measurement', () => {
  it('blocks coverage and violations together when the census is unreachable', () => {
    // Given a readable catalog but no live census
    const root = fixtureRepo();
    const blockedCensus: CensusProbe = { ok: false, state: 'BLOCKED', detail: 'bridge is unreachable' };

    // When the baseline is captured
    const result = capture(root, { mcpCensus: blockedCensus, githubGraph: LIVE_GRAPH });

    // Then no claim is graded, the claims themselves are still recorded, and
    // "zero violations" is never reported for a check that never ran
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(result.baseline.sources.map((s) => [s.sourceId, s]));
    expect(byId.get('mcp_census')?.state).toBe('BLOCKED');
    expect(byId.get('workatom_coverage')?.state).toBe('BLOCKED');
    expect(byId.get('catalog_violations')?.state).toBe('BLOCKED');
    expect(byId.get('workatom_coverage')?.data).toMatchObject({ claims: { totalAtoms: 2 }, effective: null });
    expect(byId.get('catalog_violations')?.data).toBeNull();
    expect(result.baseline.complete).toBe(false);
  });

  it('marks a parsed tracker graph with contract violations as FAIL', () => {
    // Given a fresh, parseable graph whose tracker contract evaluation failed
    const root = fixtureRepo();
    const report = evaluateTrackerTruth(parseTrackerSnapshot(readFileSync(
      new URL('./fixtures/tracker/violating.json', import.meta.url),
      'utf8',
    )));
    const violatingGraph: GraphProbe = {
      ok: true,
      value: { reportOk: report.ok, ...report, origin: 'gh://live' },
    };

    // When the baseline is captured through the typed graph seam
    const result = capture(root, { mcpCensus: LIVE_CENSUS, githubGraph: violatingGraph });

    // Then the GitHub source is FAIL and the baseline cannot be complete
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.baseline.sources.find((source) => source.sourceId === 'github_program_graph')?.state).toBe('FAIL');
    expect(result.baseline.complete).toBe(false);
    expect(baselineExitCode(result.baseline)).toBe(1);
  });

  it.each([
    ['mcp_census', { mcpCensus: { ok: false, state: 'FAIL', detail: 'malformed tools payload' } as const, githubGraph: LIVE_GRAPH }],
    ['github_program_graph', { mcpCensus: LIVE_CENSUS, githubGraph: { ok: false, state: 'FAIL', detail: 'malformed graph payload' } as const }],
  ])('refuses the baseline when the %s probe is malformed', (sourceId, probes) => {
    // Given a required live surface that responded with malformed data
    const root = fixtureRepo();

    // When the baseline is captured
    const result = capture(root, probes);

    // Then malformed is a missing required observation, never a partial success
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations).toContainEqual({
      code: 'BASELINE_SOURCE_MISSING',
      sourceId,
      detail: expect.stringContaining(sourceId),
    });
  });

  it('reports the refusal itself as an established fact when grounding refuses a claim', () => {
    // Given a claim whose cited evidence artifact does not exist
    const root = fixtureRepo({
      'data/competency/work-atoms.json': JSON.stringify({
        ...CATALOG,
        atoms: [{ ...CATALOG.atoms[0], evidence: 'outputs/never-generated.md' }, CATALOG.atoms[1]],
      }),
    });

    // When the baseline is captured
    const result = capture(root, { mcpCensus: LIVE_CENSUS, githubGraph: LIVE_GRAPH });

    // Then the violation list is a PASS observation while coverage stays unmeasured
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(result.baseline.sources.map((s) => [s.sourceId, s]));
    expect(byId.get('catalog_violations')?.state).toBe('PASS');
    expect(byId.get('catalog_violations')?.data).toMatchObject({
      violations: [{ kind: 'evidenceNotRegularFile', atomId: 'op_daily_health' }],
    });
    expect(byId.get('workatom_coverage')?.state).toBe('FAIL');
    expect(byId.get('workatom_coverage')?.data).toMatchObject({ effective: null });
  });

  it('labels the recorded 2/16-vs-1/16 discrepancy as historical rather than current coverage', () => {
    // Given the recorded pre-change discrepancy and a different current catalog
    const root = fixtureRepo();

    // When the baseline is captured
    const result = capture(root, { mcpCensus: LIVE_CENSUS, githubGraph: LIVE_GRAPH });

    // Then the historical source preserves the old counts and explicitly denies current status
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const historical = result.baseline.sources.find((s) => s.sourceId === 'historical_raw_vs_grounded');
    expect(historical?.data).toEqual({
      scope: 'historical_pre_change',
      current: false,
      rawNoGrounding: { replaced: 2, automatable: 16 },
      groundedMcp: { replaced: 1, automatable: 16 },
    });
  });

  it('refuses the baseline with BASELINE_SOURCE_MISSING when the historical record is gone', () => {
    // Given a worktree that no longer carries the required pre-change measurement
    const root = fixtureRepo();
    rmSync(join(root, HISTORICAL_RECORD));

    // When the baseline is captured
    const result = capture(root, { mcpCensus: LIVE_CENSUS, githubGraph: LIVE_GRAPH });

    // Then no partial baseline is returned and the missing source is typed
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations).toContainEqual({
      code: 'BASELINE_SOURCE_MISSING',
      sourceId: 'historical_raw_vs_grounded',
      detail: expect.stringContaining('historical_raw_vs_grounded'),
    });
  });

  it.each([
    ['missing discrepancy', JSON.stringify({ baseline: { focusedTests: {} } })],
    ['malformed JSON', '{not json'],
    ['misleading current values', JSON.stringify({
      baseline: { callerDiscrepancy: { rawNoGrounding: { replaced: 9, automatable: 16 }, groundedMcp: { replaced: 9, automatable: 16 } } },
    })],
  ])('refuses the baseline when the historical record has %s', (_case, record) => {
    // Given an evidence file that cannot establish the required historical measurement
    const root = fixtureRepo({ [HISTORICAL_RECORD]: record });

    // When the baseline is captured
    const result = capture(root, { mcpCensus: LIVE_CENSUS, githubGraph: LIVE_GRAPH });

    // Then malformed evidence is an omitted required source, not a partial success
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.map((violation) => violation.sourceId)).toContain('historical_raw_vs_grounded');
  });

  it('refuses the whole baseline when the atom file is corrupt', () => {
    // Given a catalog file that is not parseable JSON
    const root = fixtureRepo({ 'data/competency/work-atoms.json': '{ not json' });

    // When the baseline is captured
    const result = capture(root, { mcpCensus: LIVE_CENSUS, githubGraph: LIVE_GRAPH });

    // Then neither malformed catalog source can survive as a partial baseline
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.map((violation) => violation.sourceId)).toEqual(
      expect.arrayContaining(['workatom_coverage', 'catalog_violations']),
    );
  });
});
