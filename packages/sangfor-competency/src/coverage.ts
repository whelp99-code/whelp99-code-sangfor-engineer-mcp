/**
 * The honest "1인 대체율": replaced ÷ automatable, or no number at all.
 *
 * An atom counts as replaced only when it is automatable, claims field_verified,
 * names a tool the running server actually registers, cites a regular file
 * confined to the evidence root, and is not contradicted by the capability
 * maturity policy. Any claim that fails one of those checks does not drop out
 * of the numerator — it refuses the whole report, so an over-claim can never be
 * laundered into a slightly smaller but still confident percentage.
 */
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import type { CoverageContext } from './context.js';
import { loadWorkAtomCatalog } from './loader.js';
import { capabilityKey, MATURITY_RANK, type WorkAtom } from './schema.js';
import { violation, type CoverageViolation } from './violations.js';

export interface CoverageBucket {
  readonly automatable: number;
  readonly replaced: number;
  readonly human: number;
}

export interface ReplacementReport {
  readonly totalAtoms: number;
  readonly automatableAtoms: number;
  readonly humanOnlyAtoms: number;
  readonly replacedAtoms: number;
  readonly replacementRate: number;
  readonly byPhase: Readonly<Record<string, CoverageBucket>>;
  readonly byProduct: Readonly<Record<string, CoverageBucket>>;
}

export type CoverageResult =
  | { readonly ok: true; readonly report: ReplacementReport }
  | { readonly ok: false; readonly violations: readonly CoverageViolation[] };

const inside = (candidate: string, root: string): boolean =>
  candidate === root || candidate.startsWith(root + sep);

/**
 * Evidence must be a REAL regular file whose REAL path lies inside the root.
 *
 * Lexical containment only proves how a path is spelled. `outputs/link.md` spells
 * fine while pointing at /etc, and `outputs/linkdir/report.md` spells fine while
 * every byte lives outside the repo. Confinement is therefore decided after
 * resolving symlinks, and a symlink is refused even when its target is inside:
 * an artifact that can be re-aimed by editing a link is not evidence of anything.
 */
function checkEvidence(atom: WorkAtom, evidence: string, evidenceRoot: string): CoverageViolation | null {
  if (isAbsolute(evidence)) {
    return violation('evidenceOutsideRoot', atom.id, `absolute evidence path '${evidence}' is not confined to ${evidenceRoot}`);
  }
  const abs = resolve(evidenceRoot, evidence);
  if (!inside(abs, evidenceRoot)) {
    return violation('evidenceOutsideRoot', atom.id, `evidence path '${evidence}' escapes ${evidenceRoot}`);
  }

  let real: string;
  let link: ReturnType<typeof lstatSync>;
  try {
    link = lstatSync(abs);
    real = realpathSync(abs);
  } catch {
    return violation('evidenceNotRegularFile', atom.id, `evidence '${evidence}' does not resolve to a readable artifact`);
  }

  if (!inside(real, evidenceRoot)) {
    return violation('evidenceOutsideRoot', atom.id, `evidence '${evidence}' resolves to ${real}, outside ${evidenceRoot}`);
  }
  if (link.isSymbolicLink()) {
    return violation('evidenceNotRegularFile', atom.id, `evidence '${evidence}' is a symlink, not a regular artifact`);
  }
  if (!link.isFile()) {
    return violation('evidenceNotRegularFile', atom.id, `evidence '${evidence}' is not a regular file`);
  }
  return null;
}

/**
 * Checks a single field_verified, automatable claim. Returns the violations it
 * raised; an empty list means the claim is grounded and counts as replaced.
 */
function auditClaim(atom: WorkAtom, ctx: CoverageContext): readonly CoverageViolation[] {
  const found: CoverageViolation[] = [];

  if (!atom.coveredBy) found.push(violation('unregisteredTool', atom.id, 'field_verified atom names no covering tool'));
  else if (!ctx.registeredTools.has(atom.coveredBy)) {
    found.push(violation('unregisteredTool', atom.id, `coveredBy '${atom.coveredBy}' is not a registered MCP tool`));
  }

  if (!atom.evidence) found.push(violation('evidenceNotRegularFile', atom.id, 'field_verified atom cites no evidence'));
  else {
    const evidenceFault = checkEvidence(atom, atom.evidence, ctx.evidenceRoot);
    if (evidenceFault) found.push(evidenceFault);
  }

  // A claim that binds to no capability is not exempt from the maturity
  // cross-check — it is a claim the policy was never given a chance to
  // contradict, which is the cheapest way to fake the strongest maturity.
  if (!atom.capabilityRef) {
    found.push(violation('missingCapabilityRef', atom.id, 'field_verified atom names no capabilityRef, so no policy can confirm it'));
  } else {
    const key = capabilityKey(atom.capabilityRef);
    const policyMaturity = ctx.maturityByCapability.get(key);
    if (policyMaturity === undefined) {
      found.push(violation('missingCapabilityRef', atom.id, `capabilityRef '${key}' is absent from the maturity policy`));
    } else if (MATURITY_RANK[policyMaturity] < MATURITY_RANK[atom.maturity]) {
      found.push(violation('maturityBelowClaim', atom.id, `policy maturity '${policyMaturity}' is below the atom claim '${atom.maturity}'`));
    }
  }

  return found;
}

const emptyBucket = (): { automatable: number; replaced: number; human: number } => ({ automatable: 0, replaced: 0, human: 0 });

export function computeReplacementCoverage(ctx: CoverageContext): CoverageResult {
  const loaded = loadWorkAtomCatalog(ctx.catalogRoot);
  if (!loaded.ok) return loaded;

  const violations: CoverageViolation[] = [];
  const byPhase: Record<string, ReturnType<typeof emptyBucket>> = {};
  const byProduct: Record<string, ReturnType<typeof emptyBucket>> = {};
  let automatableAtoms = 0;
  let humanOnlyAtoms = 0;
  let replacedAtoms = 0;

  for (const atom of loaded.atoms) {
    const phase = (byPhase[atom.phase] ??= emptyBucket());
    const product = (byProduct[atom.product] ??= emptyBucket());

    if (atom.automatability === 'human') {
      humanOnlyAtoms += 1;
      phase.human += 1;
      product.human += 1;
      continue; // a human-only atom is never a replacement claim, however it is labelled
    }

    automatableAtoms += 1;
    phase.automatable += 1;
    product.automatable += 1;
    if (atom.maturity !== 'field_verified') continue;

    const faults = auditClaim(atom, ctx);
    if (faults.length > 0) {
      violations.push(...faults);
      continue;
    }
    replacedAtoms += 1;
    phase.replaced += 1;
    product.replaced += 1;
  }

  if (violations.length > 0) return { ok: false, violations };

  return {
    ok: true,
    report: {
      totalAtoms: loaded.atoms.length,
      automatableAtoms,
      humanOnlyAtoms,
      replacedAtoms,
      replacementRate: automatableAtoms === 0 ? 0 : replacedAtoms / automatableAtoms,
      byPhase,
      byProduct,
    },
  };
}
