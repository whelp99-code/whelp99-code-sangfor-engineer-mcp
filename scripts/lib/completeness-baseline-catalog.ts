/**
 * The WorkAtom half of the baseline: what the catalog CLAIMS and what survives grounding.
 *
 * Claims and effective coverage are two different facts and the baseline needs
 * both — a catalog can declare twenty atoms while grounding zero of them, and a
 * report that printed only one of those numbers is how the same catalog produced
 * two different rates in the first place. The fail-closed competency loaders are
 * the only reader used here, so a refusal shows up as a refusal rather than as a
 * smaller, friendlier number.
 */
import {
  CoverageContextError,
  buildCoverageContext,
  computeReplacementCoverage,
  loadMaturityPolicyStrict,
  loadWorkAtomCatalog,
  type CoverageResult,
} from '../../packages/sangfor-competency/src/index.js';
import type { BaselineObservation } from './completeness-baseline.js';
import { observe, type CollectorEnvironment, type ProbeOutcome } from './completeness-baseline-sources.js';

export interface CatalogBaselineInput {
  readonly environment: CollectorEnvironment;
  readonly catalogRoot: string;
  readonly evidenceRoot: string;
  readonly census: ProbeOutcome<{ readonly toolNames: readonly string[]; readonly origin: string }>;
}

interface CatalogClaims {
  readonly totalAtoms: number;
  readonly automatableAtoms: number;
  readonly humanOnlyAtoms: number;
  readonly fieldVerifiedClaims: readonly string[];
  readonly byMaturity: Readonly<Record<string, number>>;
}

/** The two sources this module answers, always emitted together. */
const coverageDraft = (catalogRoot: string) => ({
  sourceId: 'workatom_coverage',
  origin: catalogRoot,
  command: 'loadWorkAtomCatalog + computeReplacementCoverage against the live census',
} as const);

const violationsDraft = (catalogRoot: string) => ({
  sourceId: 'catalog_violations',
  origin: catalogRoot,
  command: 'computeReplacementCoverage → the claims it currently refuses',
} as const);

function groundedCoverage(input: CatalogBaselineInput, toolNames: readonly string[], policy: Parameters<typeof buildCoverageContext>[0]['maturityPolicy']): CoverageResult | CoverageContextError {
  try {
    return computeReplacementCoverage(buildCoverageContext({
      catalogRoot: input.catalogRoot,
      evidenceRoot: input.evidenceRoot,
      registeredTools: toolNames,
      maturityPolicy: policy,
    }));
  } catch (error) { // no-excuse-ok: catch — buildCoverageContext throws on ungrounded input
    if (error instanceof CoverageContextError) return error;
    throw error;
  }
}

export function collectCatalogBaseline(input: CatalogBaselineInput): readonly BaselineObservation[] {
  const { environment, catalogRoot, census } = input;
  const coverage = coverageDraft(catalogRoot);
  const violations = violationsDraft(catalogRoot);
  const bothRefused = (state: BaselineObservation['state'], detail: string, claims: CatalogClaims | null): readonly BaselineObservation[] => [
    observe(coverage, environment, state, detail, { claims, effective: null }),
    observe(violations, environment, state, detail, null),
  ];

  const catalog = loadWorkAtomCatalog(catalogRoot);
  // A malformed required catalog is not a FAIL observation: it is no source at
  // all. Omitting both answers makes assembly return BASELINE_SOURCE_MISSING
  // instead of shipping a partial baseline with null claim data.
  if (!catalog.ok) return [];

  const claims: CatalogClaims = {
    totalAtoms: catalog.atoms.length,
    automatableAtoms: catalog.atoms.filter((a) => a.automatability !== 'human').length,
    humanOnlyAtoms: catalog.atoms.filter((a) => a.automatability === 'human').length,
    fieldVerifiedClaims: catalog.atoms.filter((a) => a.maturity === 'field_verified').map((a) => a.id),
    byMaturity: catalog.atoms.reduce<Record<string, number>>(
      (counts, atom) => ({ ...counts, [atom.maturity]: (counts[atom.maturity] ?? 0) + 1 }),
      {},
    ),
  };

  const policy = loadMaturityPolicyStrict(catalogRoot);
  if (!policy.ok) return [];
  if (!census.ok) {
    return bothRefused(census.state, `${census.detail}; no claim can be grounded without the live census`, claims);
  }

  const result = groundedCoverage(input, census.value.toolNames, policy.entries);
  if (result instanceof CoverageContextError) {
    return bothRefused('FAIL', `coverage context refused: ${result.message}`, claims);
  }
  if (!result.ok) {
    // The refusal IS the violations observation: it was established, so that
    // source is PASS while effective coverage stays unmeasured.
    return [
      observe(
        coverage,
        environment,
        'FAIL',
        `${claims.totalAtoms} atoms claimed; effective coverage refused by ${result.violations.length} violation(s)`,
        { claims, effective: null },
      ),
      observe(
        violations,
        environment,
        'PASS',
        `${result.violations.length} catalog violation(s) currently refuse the metric`,
        { violations: result.violations },
      ),
    ];
  }
  return [
    observe(coverage, environment, 'PASS', `${claims.totalAtoms} atoms claimed; effective coverage measured`, {
      claims,
      effective: result.report,
    }),
    observe(violations, environment, 'PASS', 'no catalog violation refuses the metric', { violations: [] }),
  ];
}
