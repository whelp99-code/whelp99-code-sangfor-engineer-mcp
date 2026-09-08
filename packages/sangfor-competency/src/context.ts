/**
 * CoverageContext — the mandatory grounding for any replacement metric.
 *
 * A rate is only honest when every claim can be checked against something real:
 * the live MCP tool registry, a confined artifact root, and the capability
 * maturity policy. Grounding is therefore a constructor precondition, not an
 * options bag a caller may forget — which is exactly how the operator console
 * and the MCP tool ended up publishing two different rates from one catalog.
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { maturityPolicyEntrySchema, capabilityKey, type MaturityPolicyEntry, type Maturity } from './schema.js';
import { CoverageContextError } from './violations.js';

export interface CoverageContextInput {
  readonly catalogRoot: string;
  readonly evidenceRoot: string;
  readonly registeredTools: readonly string[];
  readonly maturityPolicy: readonly MaturityPolicyEntry[];
}

export interface CoverageContext {
  readonly catalogRoot: string;
  /** Absolute, existing directory; every evidence path must resolve inside it. */
  readonly evidenceRoot: string;
  readonly registeredTools: ReadonlySet<string>;
  /** `product::capabilityId` → declared maturity. */
  readonly maturityByCapability: ReadonlyMap<string, Maturity>;
}

/**
 * Roots are stored as REAL paths. Confinement is later decided by comparing real
 * paths, so a root reached through a symlink (macOS /tmp, a symlinked deploy
 * dir) must not compare unequal to the very files it contains.
 */
const requireDirectory = (field: string, path: string): string => {
  const abs = resolve(path);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new CoverageContextError(field, `must be an existing directory (got ${path})`);
  }
  return realpathSync(abs);
};

export function buildCoverageContext(input: CoverageContextInput): CoverageContext {
  const registeredTools = new Set(input.registeredTools.map((t) => t.trim()).filter((t) => t.length > 0));
  if (registeredTools.size === 0) {
    throw new CoverageContextError('registeredTools', 'must name at least one registered MCP tool');
  }

  // Same reasoning as the policy file schema: an empty policy cannot confirm
  // anything, so accepting one here would let a caller switch the cross-check
  // off by passing [] rather than by declaring a capability.
  if (input.maturityPolicy.length === 0) {
    throw new CoverageContextError('maturityPolicy', 'must declare at least one capability');
  }

  const maturityByCapability = new Map<string, Maturity>();
  for (const raw of input.maturityPolicy) {
    const parsed = maturityPolicyEntrySchema.safeParse(raw);
    if (!parsed.success) {
      throw new CoverageContextError('maturityPolicy', `invalid entry: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    }
    const key = capabilityKey(parsed.data);
    // Two rows for one capability means the policy does not have an opinion, it
    // has two. Silently keeping the last would let a duplicate promote a claim.
    if (maturityByCapability.has(key)) {
      throw new CoverageContextError('maturityPolicy', `capability '${key}' is declared more than once`);
    }
    maturityByCapability.set(key, parsed.data.maturity);
  }

  return {
    catalogRoot: requireDirectory('catalogRoot', input.catalogRoot),
    evidenceRoot: requireDirectory('evidenceRoot', input.evidenceRoot),
    registeredTools,
    maturityByCapability,
  };
}
