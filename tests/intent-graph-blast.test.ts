import { describe, expect, it } from 'vitest';
import {
  blastRadius,
  prioritize,
  type Finding,
  type IntentEdge,
  type IntentGraph,
} from '../packages/sangfor-intent-graph/src/index.js';

const edge = (from: string, to: string): IntentEdge => ({
  kind: 'cluster-member',
  from,
  to,
  derivedFrom: 'declared',
  confidence: 1,
  evidence: [{ observedKey: 'cluster.id', value: 'c1' }],
});

// a -> b -> c, a -> d, isolated e
const graph: IntentGraph = {
  nodes: ['a', 'b', 'c', 'd', 'e'].map((deviceId) => ({ deviceId, product: 'HCI' })),
  edges: [edge('a', 'b'), edge('b', 'c'), edge('a', 'd')],
};

describe('@sangfor/intent-graph — blast radius (design 002, D2)', () => {
  it('counts every transitively reachable dependent', () => {
    expect(blastRadius(graph, 'a')).toBe(3);
    expect(blastRadius(graph, 'b')).toBe(1);
    expect(blastRadius(graph, 'c')).toBe(0);
    expect(blastRadius(graph, 'e')).toBe(0);
  });

  it('never counts the device itself and terminates on a cycle', () => {
    const cyclic: IntentGraph = { nodes: graph.nodes, edges: [...graph.edges, edge('c', 'a')] };
    expect(blastRadius(cyclic, 'a')).toBe(3);
    expect(blastRadius(cyclic, 'c')).toBe(3);
  });

  it('returns zero for a device that is not in the graph', () => {
    expect(blastRadius(graph, 'ghost')).toBe(0);
  });
});

const findings: Finding[] = [
  { id: 'f-low-a', deviceId: 'a', severity: 'low' },
  { id: 'f-high-c', deviceId: 'c', severity: 'high' },
  { id: 'f-medium-b', deviceId: 'b', severity: 'medium' },
];

const fresh = { graphCapturedAt: '2026-08-18T05:59:00.000Z', maxGraphAgeSec: 3600, now: '2026-08-18T06:00:00.000Z' };

describe('@sangfor/intent-graph — triage prioritisation (design 002, D2)', () => {
  it('ranks by severity x blast weight on a fresh graph', () => {
    const result = prioritize(findings, graph, fresh);
    expect(result.degraded).toBeUndefined();
    // a low finding on the hub (blast 3) outranks a high finding on a leaf (blast 0)
    expect(result.items.map((i) => i.id)).toEqual(['f-medium-b', 'f-low-a', 'f-high-c']);
    expect(result.items[0]).toEqual({ id: 'f-medium-b', deviceId: 'b', severity: 'medium', blast: 1, score: 4 });
    expect(result.items[1]).toEqual({ id: 'f-low-a', deviceId: 'a', severity: 'low', blast: 3, score: 4 });
    expect(result.items[2]).toEqual({ id: 'f-high-c', deviceId: 'c', severity: 'high', blast: 0, score: 3 });
  });

  it('breaks score ties by severity, then by finding id — stable and deterministic', () => {
    const result = prioritize(findings, graph, fresh);
    expect(result.items.map((i) => i.id)).toEqual(prioritize([...findings].reverse(), graph, fresh).items.map((i) => i.id));
  });

  it('falls back to severity-only ordering and marks degraded when the graph snapshot is stale', () => {
    const stale = prioritize(findings, graph, { graphCapturedAt: '2026-08-18T04:00:00.000Z', maxGraphAgeSec: 3600, now: '2026-08-18T06:00:00.000Z' });
    expect(stale.degraded).toBe('stale-graph');
    expect(stale.items.map((i) => i.id)).toEqual(['f-high-c', 'f-medium-b', 'f-low-a']);
    // blast weight must not leak into a degraded score
    expect(stale.items.map((i) => i.blast)).toEqual([0, 0, 0]);
    expect(stale.items.map((i) => i.score)).toEqual([3, 2, 1]);
  });

  it('treats a missing or unparseable capture time as stale rather than fresh', () => {
    for (const graphCapturedAt of [undefined, 'whenever']) {
      const result = prioritize(findings, graph, { graphCapturedAt, maxGraphAgeSec: 3600, now: '2026-08-18T06:00:00.000Z' });
      expect(result.degraded).toBe('stale-graph');
      expect(result.items.map((i) => i.id)).toEqual(['f-high-c', 'f-medium-b', 'f-low-a']);
    }
  });

  it('keeps critical above high at equal blast', () => {
    const two: Finding[] = [
      { id: 'f-high', deviceId: 'e', severity: 'high' },
      { id: 'f-critical', deviceId: 'e', severity: 'critical' },
    ];
    expect(prioritize(two, graph, fresh).items.map((i) => i.id)).toEqual(['f-critical', 'f-high']);
  });

  it('returns an empty list for no findings without inventing entries', () => {
    expect(prioritize([], graph, fresh).items).toEqual([]);
  });
});
