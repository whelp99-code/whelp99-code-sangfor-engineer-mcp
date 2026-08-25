/**
 * Project-completeness report — the CLI surface over the honest replacement metric.
 *
 * `--strict` is the whole point: an unverifiable catalog exits nonzero and prints
 * the typed violations, so no dashboard, README, or slide can quote a percentage
 * that the grounding checks would have refused. There is no partial-metric mode,
 * the flag surface is closed (a typo'd flag is an error, never a silent no-op),
 * and the tool census comes from the live bridge rather than a list written here.
 *
 * `--baseline --json` widens the same discipline from one metric to the whole
 * readiness picture: nine declared sources, each with its origin, the command
 * that produced it, and a PASS/FAIL/BLOCKED/NOT_RUN state. An omitted source
 * refuses the artifact (`BASELINE_SOURCE_MISSING`), and an unreachable surface
 * is recorded as blocked rather than being rounded up to a green baseline.
 */
import { execFileSync } from 'node:child_process';
import {
  buildCoverageContext,
  computeReplacementCoverage,
  defaultCatalogRoot,
  fetchBridgeToolRegistry,
  loadMaturityPolicyStrict,
  bridgeUrlFromEnv,
  type CoverageViolation,
} from '../packages/sangfor-competency/src/index.js';
import { resolveRepoData } from '../packages/shared/src/index.js';
import { baselineExitCode, runBaseline, type CensusProbe, type GraphProbe } from './lib/completeness-baseline-run.js';
import { evaluateTrackerTruth, parseTrackerSnapshot } from './lib/tracker-truth.js';

const BOOLEAN_FLAGS = ['--strict', '--json', '--baseline'] as const;
const VALUE_FLAGS = ['--catalog-root', '--evidence-root', '--registry-url', '--historical-record'] as const;

type BooleanFlag = (typeof BOOLEAN_FLAGS)[number];
type ValueFlag = (typeof VALUE_FLAGS)[number];

interface CliOptions {
  readonly strict: boolean;
  readonly json: boolean;
  readonly baseline: boolean;
  readonly catalogRoot: string;
  readonly evidenceRoot: string;
  readonly registryUrl: string;
  readonly historicalRecord: string;
}

const DEFAULT_HISTORICAL_RECORD = '.omo/evidence/project-completeness/task-2-project-completeness-production-readiness.json';
const TRACKER_REPO = process.env.TRACKER_REPO ?? 'whelp99-code/whelp99-code-sangfor-engineer-mcp';

class CliUsageError extends Error {}

const isBooleanFlag = (token: string): token is BooleanFlag => BOOLEAN_FLAGS.includes(token as BooleanFlag);
const isValueFlag = (token: string): token is ValueFlag => VALUE_FLAGS.includes(token as ValueFlag);

function parseArgs(argv: readonly string[]): CliOptions {
  const booleans = new Set<BooleanFlag>();
  const values = new Map<ValueFlag, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;
    if (isBooleanFlag(token)) { booleans.add(token); continue; }
    if (isValueFlag(token)) {
      const value = argv[i + 1];
      // A flag as the "value" means the operator dropped an argument; consuming
      // it would silently reconfigure a different flag than they meant to set.
      if (value === undefined || value.startsWith('--')) {
        throw new CliUsageError(`${token} requires a value`);
      }
      values.set(token, value);
      i += 1;
      continue;
    }
    throw new CliUsageError(
      `unknown argument '${token}' (accepted: ${[...BOOLEAN_FLAGS, ...VALUE_FLAGS].join(', ')})`,
    );
  }

  return {
    strict: booleans.has('--strict'),
    json: booleans.has('--json'),
    baseline: booleans.has('--baseline'),
    catalogRoot: values.get('--catalog-root') ?? defaultCatalogRoot(),
    evidenceRoot: values.get('--evidence-root') ?? resolveRepoData('.', 'SANGFOR_OUTPUT_ROOT'),
    registryUrl: values.get('--registry-url') ?? bridgeUrlFromEnv(),
    historicalRecord: values.get('--historical-record') ?? DEFAULT_HISTORICAL_RECORD,
  };
}

function renderViolations(violations: readonly CoverageViolation[], json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: false, violations }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`project completeness: MEASUREMENT REFUSED (${violations.length} violation(s))\n`);
  for (const v of violations) process.stdout.write(`  - [${v.kind}] ${v.atomId ?? '<catalog>'}: ${v.detail}\n`);
}

async function censusProbe(registryUrl: string): Promise<CensusProbe> {
  const registry = await fetchBridgeToolRegistry(registryUrl);
  if (registry.ok) return { ok: true, value: { toolNames: registry.toolNames, origin: `${registryUrl}/tools` } };
  // Unreachable is an environment blocker; a schema-invalid or empty census is a
  // failure of the surface itself. Collapsing the two would let "nobody started
  // the bridge" and "the bridge lies" share one indistinguishable state.
  const blocked = registry.violations.some((v) => v.kind === 'registryUnreachable');
  return {
    ok: false,
    state: blocked ? 'BLOCKED' : 'FAIL',
    detail: registry.violations.map((v) => `[${v.kind}] ${v.detail}`).join('; '),
  };
}

const GH_LIMIT = '200';
const GH_ISSUE_FIELDS = 'number,state,title,createdAt,labels,body';
const GH_PR_FIELDS = 'number,state,createdAt,body';

function graphProbe(): GraphProbe {
  try { // no-excuse-ok: catch — `gh` is an external process boundary
    const gh = (args: readonly string[]): unknown =>
      JSON.parse(execFileSync('gh', [...args], { encoding: 'utf8', maxBuffer: 32_000_000, timeout: 60_000 }));
    const issues = gh(['issue', 'list', '--repo', TRACKER_REPO, '--state', 'all', '--limit', GH_LIMIT, '--json', GH_ISSUE_FIELDS, '--jq', '[.[] | {number, state, title, createdAt, labels: [.labels[].name], body}]']);
    const pullRequests = gh(['pr', 'list', '--repo', TRACKER_REPO, '--state', 'all', '--limit', GH_LIMIT, '--json', GH_PR_FIELDS, '--jq', '[.[] | {number, state, createdAt, body}]']);
    const report = evaluateTrackerTruth(parseTrackerSnapshot(JSON.stringify({ version: 1, issues, pullRequests })));
    return { ok: true, value: { reportOk: report.ok, ...report, origin: `gh://${TRACKER_REPO}` } };
  } catch (error) {
    return {
      ok: false,
      state: 'BLOCKED',
      detail: `live tracker graph unavailable: ${error instanceof Error ? error.message : 'unknown error'}`,
    };
  }
}

async function runBaselineMode(options: CliOptions): Promise<number> {
  // The baseline is a machine artifact by definition; a human-readable rendering
  // of nine nested source records would be a second, drift-prone format.
  if (!options.json) throw new CliUsageError('--baseline requires --json');

  const [mcpCensus, githubGraph] = [await censusProbe(options.registryUrl), graphProbe()];
  const result = runBaseline({
    environment: { repoRoot: resolveRepoData('.'), collectedAt: new Date().toISOString(), env: process.env },
    roots: { catalog: options.catalogRoot, evidence: options.evidenceRoot, historicalRecord: options.historicalRecord },
    probes: { mcpCensus, githubGraph },
  });

  if (!result.ok) {
    process.stdout.write(`${JSON.stringify({ ok: false, marker: 'BASELINE_REFUSED', violations: result.violations }, null, 2)}\n`);
    return 3;
  }
  process.stdout.write(`${JSON.stringify({ ok: true, marker: 'BASELINE_CAPTURED', baseline: result.baseline }, null, 2)}\n`);
  // Environment blockers and current catalog debt are honest baseline facts,
  // but a fresh GitHub graph that violates its contract is a failed mandatory
  // source and must make automation fail.
  return baselineExitCode(result.baseline);
}

async function run(options: CliOptions): Promise<number> {
  if (options.baseline) return runBaselineMode(options);

  // The census is whatever the running server advertises — never a name written
  // into this file, which would grade a claim against a tool nobody serves.
  const registry = await fetchBridgeToolRegistry(options.registryUrl);
  if (!registry.ok) {
    renderViolations(registry.violations, options.json);
    return 1;
  }

  // The policy lives beside the atoms it governs (data/competency holds both),
  // so one --catalog-root moves the pair together; splitting them would let a
  // catalog be graded against a policy describing different capabilities.
  const policy = loadMaturityPolicyStrict(options.catalogRoot);
  if (!policy.ok) {
    renderViolations(policy.violations, options.json);
    return 1;
  }

  const result = computeReplacementCoverage(buildCoverageContext({
    catalogRoot: options.catalogRoot,
    evidenceRoot: options.evidenceRoot,
    registeredTools: registry.toolNames,
    maturityPolicy: policy.entries,
  }));

  if (!result.ok) {
    renderViolations(result.violations, options.json);
    // Without --strict the violations are still the only output; there is no
    // fallback number to print, so the exit code is the only thing that softens.
    return options.strict ? 1 : 0;
  }

  const { report } = result;
  if (options.json) process.stdout.write(`${JSON.stringify({ ok: true, report }, null, 2)}\n`);
  else {
    process.stdout.write(
      `project completeness: ${(report.replacementRate * 100).toFixed(1)}% ` +
      `(${report.replacedAtoms}/${report.automatableAtoms} automatable replaced, ` +
      `${report.humanOnlyAtoms} human-only, ${report.totalAtoms} total)\n`,
    );
  }
  return 0;
}

async function main(): Promise<number> { // no-excuse-ok: catch
  try {
    return await run(parseArgs(process.argv.slice(2)));
  } catch (error) {
    if (error instanceof CliUsageError) {
      process.stderr.write(`report-project-completeness: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

process.exit(await main());
