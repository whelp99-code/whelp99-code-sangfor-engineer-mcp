/**
 * @sangfor/competency — Field-engineer WorkAtom taxonomy + honest replacement metric.
 *
 * Each WorkAtom is one unit of a field engineer's job, labelled auto/hybrid/human.
 * The replacement rate counts ONLY atoms that are automatable AND field_verified —
 * "an MCP tool exists" never counts as replaced; a human-only atom never counts even
 * if mislabelled as covered. This keeps "1인 대체율" honest.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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
}

export interface ReplacementCoverage {
  totalAtoms: number;
  automatableAtoms: number;   // auto or hybrid
  humanOnlyAtoms: number;     // never replaceable
  replacedAtoms: number;      // automatable AND field_verified AND coveredBy
  replacementRate: number;    // replacedAtoms / automatableAtoms
  byPhase: Record<string, { automatable: number; replaced: number; human: number }>;
  byProduct: Record<string, { automatable: number; replaced: number; human: number }>;
}

const DATA_ROOT = process.env.SANGFOR_COMPETENCY_ROOT ?? 'data/competency';

export function loadWorkAtoms(root: string = DATA_ROOT): WorkAtom[] {
  if (!existsSync(root)) return [];
  const out: WorkAtom[] = [];
  for (const f of readdirSync(root).filter((x) => x.endsWith('.json') && !x.startsWith('.'))) {
    const parsed = JSON.parse(readFileSync(join(root, f), 'utf8'));
    const arr = Array.isArray(parsed) ? parsed : parsed.atoms;
    if (Array.isArray(arr)) out.push(...(arr as WorkAtom[])); // ignore non-atom files (e.g. capability-maturity.json)
  }
  return out;
}

function isReplaced(a: WorkAtom): boolean {
  // Honest: automatable, field_verified, covered, AND carrying a real evidence link.
  return a.automatability !== 'human' && a.maturity === 'field_verified' && !!a.coveredBy && !!a.evidence;
}

export function computeReplacementCoverage(rawAtoms: WorkAtom[] = loadWorkAtoms()): ReplacementCoverage {
  const atoms = [...new Map(rawAtoms.map((a) => [a.id, a])).values()]; // dedupe by id (no inflation)
  const automatable = atoms.filter((a) => a.automatability !== 'human');
  const human = atoms.filter((a) => a.automatability === 'human');
  const replaced = atoms.filter(isReplaced);

  const bucket = () => ({ automatable: 0, replaced: 0, human: 0 });
  const byPhase: Record<string, ReturnType<typeof bucket>> = {};
  const byProduct: Record<string, ReturnType<typeof bucket>> = {};
  for (const a of atoms) {
    byPhase[a.phase] ??= bucket();
    byProduct[a.product] ??= bucket();
    if (a.automatability === 'human') { byPhase[a.phase].human++; byProduct[a.product].human++; }
    else { byPhase[a.phase].automatable++; byProduct[a.product].automatable++; }
    if (isReplaced(a)) { byPhase[a.phase].replaced++; byProduct[a.product].replaced++; }
  }

  return {
    totalAtoms: atoms.length,
    automatableAtoms: automatable.length,
    humanOnlyAtoms: human.length,
    replacedAtoms: replaced.length,
    replacementRate: automatable.length ? replaced.length / automatable.length : 0,
    byPhase,
    byProduct,
  };
}
