/**
 * The one repo-anchored CoverageContext every surface must use.
 *
 * The MCP tool and the operator console previously assembled their own grounding
 * and disagreed — one checked coveredBy against the tool registry, the other did
 * not, so the same catalog printed two different replacement rates. Both now call
 * this factory, so a disagreement between surfaces is impossible by construction:
 * the only per-caller input left is the live tool census that caller can prove.
 */
import { resolveRepoData } from '../../shared/src/index.js';
import { buildCoverageContext, type CoverageContext } from './context.js';
import { defaultCatalogRoot } from './loader.js';
import { loadMaturityPolicyStrict } from './policy.js';
import type { CoverageViolation } from './violations.js';

export type RepoCoverageContextLoad =
  | { readonly ok: true; readonly context: CoverageContext }
  | { readonly ok: false; readonly violations: readonly CoverageViolation[] };

/**
 * @param registeredTools the live census the calling surface can prove — a claim
 * covered by anything outside it is unverifiable, not merely stale.
 */
export function buildRepoCoverageContext(registeredTools: readonly string[]): RepoCoverageContextLoad {
  // The policy is loaded strictly here rather than through the safety oracle:
  // safety degrades a corrupt policy to "no evidence" (correct for a gate,
  // catastrophic for a report, where it would erase every cross-check).
  const policy = loadMaturityPolicyStrict();
  if (!policy.ok) return policy;

  return {
    ok: true,
    context: buildCoverageContext({
      catalogRoot: defaultCatalogRoot(),
      // Anchored to the repo root the atoms come from, NOT process.cwd — a cwd
      // anchor would disagree with the loader and zero the rate when run off-repo.
      evidenceRoot: resolveRepoData('.', 'SANGFOR_OUTPUT_ROOT'),
      registeredTools,
      maturityPolicy: policy.entries,
    }),
  };
}
