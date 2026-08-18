/**
 * Intent graph derivation (design 002, block D1).
 *
 * Device relationships (HA pair, VPN peer, VLAN membership, cluster membership)
 * are DERIVED from observed facts by rules the caller injects — this package
 * hard-codes no vendor heuristics, so a wrong matcher is a data fix, not a code
 * fix. Every derived edge carries the evidence (observedKey + value) that
 * produced it: an edge nobody can justify from observed facts is never emitted.
 *
 * Pure and deterministic: device iteration follows the insertion order of the
 * observed map and rules are applied in the given order, so the same input
 * always yields the same graph.
 */

export type EdgeKind = 'ha-pair' | 'vpn-peer' | 'vlan-member' | 'cluster-member';
export type EdgeProvenance = 'declared' | 'inferred';

export interface EdgeEvidence {
  observedKey: string;
  value: unknown;
}

export interface IntentNode {
  deviceId: string;
  product: string;
}

export interface IntentEdge {
  kind: EdgeKind;
  from: string;
  to: string;
  derivedFrom: EdgeProvenance;
  confidence: number;
  evidence: EdgeEvidence[];
}

export interface IntentGraph {
  nodes: IntentNode[];
  edges: IntentEdge[];
}

export interface RuleDevice {
  deviceId: string;
  observed: Record<string, unknown>;
}

export interface EdgeRule {
  kind: EdgeKind;
  derivedFrom: EdgeProvenance;
  confidence: number;
  /** Return the evidence for a from→to edge, or null when this ordered pair does not relate. */
  match: (from: RuleDevice, to: RuleDevice) => EdgeEvidence[] | null;
}

export interface DeriveEdgesOptions {
  /** Product code per device; devices without one are recorded as UNKNOWN, never guessed. */
  products?: Record<string, string>;
}

/**
 * Build the graph for the observed devices under the injected rules. Every
 * ordered device pair is offered to every rule; a rule that returns no evidence
 * (or an empty evidence list) produces no edge, and self-pairs are never tested.
 */
export function deriveEdges(
  observedByDevice: Record<string, Record<string, unknown>>,
  rules: readonly EdgeRule[],
  options: DeriveEdgesOptions = {},
): IntentGraph {
  const devices: RuleDevice[] = Object.entries(observedByDevice).map(([deviceId, observed]) => ({ deviceId, observed }));
  const nodes: IntentNode[] = devices.map((device) => ({
    deviceId: device.deviceId,
    product: options.products?.[device.deviceId] ?? 'UNKNOWN',
  }));

  const edges: IntentEdge[] = [];
  for (const rule of rules) {
    for (const from of devices) {
      for (const to of devices) {
        if (from.deviceId === to.deviceId) continue;
        const evidence = rule.match(from, to);
        if (evidence === null || evidence.length === 0) continue;
        edges.push({
          kind: rule.kind,
          from: from.deviceId,
          to: to.deviceId,
          derivedFrom: rule.derivedFrom,
          confidence: rule.confidence,
          evidence: evidence.map((e) => ({ observedKey: e.observedKey, value: e.value })),
        });
      }
    }
  }
  return { nodes, edges };
}
