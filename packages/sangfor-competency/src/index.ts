/**
 * @sangfor/competency — Field-engineer WorkAtom taxonomy + honest replacement metric.
 *
 * Each WorkAtom is one unit of a field engineer's job, labelled auto/hybrid/human.
 * The replacement rate counts ONLY atoms that are automatable AND field_verified —
 * "an MCP tool exists" never counts as replaced; a human-only atom never counts even
 * if mislabelled as covered. This keeps "1인 대체율" honest.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, isAbsolute, sep } from 'node:path';
import { resolveRepoData } from '../../shared/src/index.js';

export type LifecyclePhase = 'discover' | 'design' | 'validate' | 'deploy' | 'operate' | 'handover' | 'incident';
export type Automatability = 'auto' | 'hybrid' | 'human';
export type Maturity = 'planned' | 'implemented_local' | 'tested_mock' | 'field_verified';

export interface WorkAtom {
  id: string;
  product: string;
  phase: LifecyclePhase;
  title: string;
  automatability: Automatability;
  humanReason?: string;
  coveredBy?: string | null;
  maturity: Maturity;
  evidence?: string | null; // field-verified atoms MUST carry a real evidence link (device capture / artifact)
  capabilityRef?: { product: string; capabilityId: string };
}

export interface MaturityPolicyEntry {
  product: string;
  capabilityId: string;
  maturity: string;
}

export interface ReplacementCoverage {
  totalAtoms: number;
  automatableAtoms: number;   // auto or hybrid
  humanOnlyAtoms: number;     // never replaceable
  replacedAtoms: number;      // automatable AND field_verified AND coveredBy
  replacementRate: number;    // replacedAtoms / automatableAtoms
  byPhase: Record<string, { automatable: number; replaced: number; human: number }>;
  byProduct: Record<string, { automatable: number; replaced: number; human: number }>;
  unknownCoverage: Array<{ atomId: string; coveredBy: string }>;  // would-be replaced, but coveredBy is not a registered tool
  evidenceMissing: Array<{ atomId: string; evidence: string }>;   // would-be replaced, but evidence is not a real artifact path
  maturityConflicts: Array<{ atomId: string; atomMaturity: string; policyMaturity: string }>;
  unverifiedClaims: Array<{ atomId: string; reason: string }>;
}

/**
 * Optional stronger verification. When provided:
 *  - knownTools: coveredBy must name a tool that actually exists in the MCP registry.
 *  - evidenceRoot: evidence must resolve to a real file/dir on disk (prose is rejected).
 * When omitted, the legacy non-empty checks apply (backward compatible).
 */
export interface CoverageOptions {
  knownTools?: Set<string>;
  evidenceRoot?: string;
  maturityPolicy?: MaturityPolicyEntry[];
}

type ReplacementStatus = 'replaced' | 'unknownCoverage' | 'evidenceMissing' | 'unverifiedMaturity' | 'no';

const MATURITY_RANK: Record<Maturity, number> = {
  planned: 0,
  implemented_local: 1,
  tested_mock: 2,
  field_verified: 3,
};

function maturityRank(value: string): number {
  return MATURITY_RANK[value as Maturity] ?? -1;
}

function findPolicyMaturity(a: WorkAtom, opts: CoverageOptions): string | undefined {
  if (!a.capabilityRef || !opts.maturityPolicy) return undefined;
  return opts.maturityPolicy.find((entry) =>
    entry.product === a.capabilityRef!.product && entry.capabilityId === a.capabilityRef!.capabilityId
  )?.maturity;
}

/**
 * Evidence counts only when it is a REAL ARTIFACT FILE confined to evidenceRoot.
 * A bare directory (e.g. 'outputs' or '.'), an absolute path, or a traversal that
 * escapes the root must NOT count — otherwise "1인 대체율" inflates by pointing
 * evidence at any folder or any file that happens to exist on the host.
 */
function evidenceIsArtifact(evidence: string, evidenceRoot: string): boolean {
  const raw = String(evidence).trim();
  if (!raw || isAbsolute(raw)) return false;
  const rootAbs = resolve(evidenceRoot);
  const abs = resolve(rootAbs, raw);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) return false; // escapes the root
  try {
    return statSync(abs).isFile(); // must be a file artifact, not a directory
  } catch {
    return false; // does not exist
  }
}

function replacementStatus(a: WorkAtom, opts: CoverageOptions): ReplacementStatus {
  if (a.automatability === 'human') return 'no';
  const policyMaturity = findPolicyMaturity(a, opts);
  const effectiveMaturity = policyMaturity && maturityRank(policyMaturity) < maturityRank(a.maturity)
    ? policyMaturity
    : a.maturity;
  if (effectiveMaturity !== 'field_verified') {
    if (a.maturity === 'field_verified' && policyMaturity && maturityRank(policyMaturity) < maturityRank(a.maturity)) {
      return 'unverifiedMaturity';
    }
    return 'no';
  }
  if (!a.coveredBy || !a.evidence) return 'no';
  // Base candidate met. Apply stronger checks only when the caller supplies grounds.
  if (opts.knownTools && !opts.knownTools.has(a.coveredBy)) return 'unknownCoverage';
  if (opts.evidenceRoot && !evidenceIsArtifact(String(a.evidence), opts.evidenceRoot)) return 'evidenceMissing';
  return 'replaced';
}

const dataRoot = () => resolveRepoData('data/competency', 'SANGFOR_COMPETENCY_ROOT');

export function loadWorkAtoms(root: string = dataRoot()): WorkAtom[] {
  if (!existsSync(root)) return [];
  const out: WorkAtom[] = [];
  for (const f of readdirSync(root).filter((x) => x.endsWith('.json') && !x.startsWith('.'))) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(root, f), 'utf8'));
    } catch {
      process.stderr.write(`[competency] skipping unparseable atom file: ${f}\n`);
      continue; // one corrupt file must not take down the whole catalog
    }
    const arr = Array.isArray(parsed) ? parsed : (parsed as { atoms?: unknown }).atoms;
    if (Array.isArray(arr)) out.push(...(arr as WorkAtom[])); // ignore non-atom files (e.g. capability-maturity.json)
  }
  return out;
}

export function computeReplacementCoverage(rawAtoms: WorkAtom[] = loadWorkAtoms(), opts: CoverageOptions = {}): ReplacementCoverage {
  const atoms = [...new Map(rawAtoms.map((a) => [a.id, a])).values()]; // dedupe by id (no inflation)
  const automatable = atoms.filter((a) => a.automatability !== 'human');
  const human = atoms.filter((a) => a.automatability === 'human');

  const bucket = () => ({ automatable: 0, replaced: 0, human: 0 });
  const byPhase: Record<string, ReturnType<typeof bucket>> = {};
  const byProduct: Record<string, ReturnType<typeof bucket>> = {};
  const unknownCoverage: Array<{ atomId: string; coveredBy: string }> = [];
  const evidenceMissing: Array<{ atomId: string; evidence: string }> = [];
  const maturityConflicts: Array<{ atomId: string; atomMaturity: string; policyMaturity: string }> = [];
  const unverifiedClaims: Array<{ atomId: string; reason: string }> = [];
  let replacedAtoms = 0;

  for (const a of atoms) {
    byPhase[a.phase] ??= bucket();
    byProduct[a.product] ??= bucket();
    if (a.automatability === 'human') { byPhase[a.phase].human++; byProduct[a.product].human++; }
    else { byPhase[a.phase].automatable++; byProduct[a.product].automatable++; }

    const status = replacementStatus(a, opts);
    if (status === 'replaced') {
      replacedAtoms++;
      byPhase[a.phase].replaced++; byProduct[a.product].replaced++;
    } else if (status === 'unknownCoverage') {
      unknownCoverage.push({ atomId: a.id, coveredBy: a.coveredBy! });
    } else if (status === 'evidenceMissing') {
      evidenceMissing.push({ atomId: a.id, evidence: String(a.evidence) });
    } else if (status === 'unverifiedMaturity') {
      const policyMaturity = findPolicyMaturity(a, opts)!;
      maturityConflicts.push({ atomId: a.id, atomMaturity: a.maturity, policyMaturity });
      unverifiedClaims.push({
        atomId: a.id,
        reason: `capability policy maturity ${policyMaturity} is lower than atom maturity ${a.maturity}`,
      });
    }
  }

  return {
    totalAtoms: atoms.length,
    automatableAtoms: automatable.length,
    humanOnlyAtoms: human.length,
    replacedAtoms,
    replacementRate: automatable.length ? replacedAtoms / automatable.length : 0,
    byPhase,
    byProduct,
    unknownCoverage,
    evidenceMissing,
    maturityConflicts,
    unverifiedClaims,
  };
}
