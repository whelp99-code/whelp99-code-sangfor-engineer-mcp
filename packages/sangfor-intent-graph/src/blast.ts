/**
 * Blast-radius triage index (design 002, block D2).
 *
 * A finding on a device that many others depend on outranks the same finding on
 * a leaf. Downstream weight is the number of devices reachable from the device
 * by following edges outward (transitive dependents), computed by BFS so cycles
 * terminate and the device itself never counts toward its own blast.
 *
 * Safety rule: the graph is a snapshot and topology drifts. When the snapshot is
 * older than the caller's budget — or its capture time is missing/unparseable —
 * the blast weight is not evidence, so ordering falls back to severity alone and
 * the result is marked degraded: 'stale-graph'. Priority is never silently
 * computed from a topology we cannot vouch for.
 */
import type { IntentGraph } from './graph.js';

export type FindingSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface Finding {
  id: string;
  deviceId: string;
  severity: FindingSeverity;
}

export interface PrioritizedFinding extends Finding {
  /** Reachable dependents used for the score; always 0 in degraded mode. */
  blast: number;
  score: number;
}

export interface PrioritizeOptions {
  graphCapturedAt?: string;
  maxGraphAgeSec: number;
  now: string;
}

export interface PrioritizeResult {
  items: PrioritizedFinding[];
  degraded?: 'stale-graph';
}

const SEVERITY_WEIGHT: Record<FindingSeverity, number> = { low: 1, medium: 2, high: 3, critical: 4 };

/** Count of devices transitively reachable from deviceId, excluding itself. */
export function blastRadius(graph: IntentGraph, deviceId: string): number {
  const reached = new Set<string>();
  const queue: string[] = [deviceId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const edge of graph.edges) {
      if (edge.from !== current) continue;
      if (edge.to === deviceId || reached.has(edge.to)) continue;
      reached.add(edge.to);
      queue.push(edge.to);
    }
  }
  return reached.size;
}

function isGraphFresh(options: PrioritizeOptions): boolean {
  if (options.graphCapturedAt === undefined) return false;
  const captured = Date.parse(options.graphCapturedAt);
  const now = Date.parse(options.now);
  if (Number.isNaN(captured) || Number.isNaN(now)) return false;
  return (now - captured) / 1000 <= options.maxGraphAgeSec;
}

/**
 * Order findings by severity x blast weight (score = severity * (1 + blast)),
 * highest first, with deterministic tie-breaking on severity then finding id.
 * A stale graph degrades to severity-only ordering.
 */
export function prioritize(
  findings: readonly Finding[],
  graph: IntentGraph,
  options: PrioritizeOptions,
): PrioritizeResult {
  const fresh = isGraphFresh(options);
  const items: PrioritizedFinding[] = findings.map((finding) => {
    const blast = fresh ? blastRadius(graph, finding.deviceId) : 0;
    return { ...finding, blast, score: SEVERITY_WEIGHT[finding.severity] * (1 + blast) };
  });

  items.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const severity = SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity];
    if (severity !== 0) return severity;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return fresh ? { items } : { items, degraded: 'stale-graph' };
}
