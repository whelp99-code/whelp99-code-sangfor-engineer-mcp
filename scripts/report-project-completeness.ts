/**
 * Project-completeness report — the CLI surface over the honest replacement metric.
 *
 * `--strict` is the whole point: an unverifiable catalog exits nonzero and prints
 * the typed violations, so no dashboard, README, or slide can quote a percentage
 * that the grounding checks would have refused. There is no partial-metric mode,
 * the flag surface is closed (a typo'd flag is an error, never a silent no-op),
 * and the tool census comes from the live bridge rather than a list written here.
 */
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

const BOOLEAN_FLAGS = ['--strict', '--json'] as const;
const VALUE_FLAGS = ['--catalog-root', '--evidence-root', '--registry-url'] as const;

type BooleanFlag = (typeof BOOLEAN_FLAGS)[number];
type ValueFlag = (typeof VALUE_FLAGS)[number];

interface CliOptions {
  readonly strict: boolean;
  readonly json: boolean;
  readonly catalogRoot: string;
  readonly evidenceRoot: string;
  readonly registryUrl: string;
}

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
    catalogRoot: values.get('--catalog-root') ?? defaultCatalogRoot(),
    evidenceRoot: values.get('--evidence-root') ?? resolveRepoData('.', 'SANGFOR_OUTPUT_ROOT'),
    registryUrl: values.get('--registry-url') ?? bridgeUrlFromEnv(),
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

async function run(options: CliOptions): Promise<number> {
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
