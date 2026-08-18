import { describe, expect, it } from 'vitest';
import {
  assembleCrossDeviceObserved,
  deriveEdges,
  evaluateCrossDeviceSpec,
  type EdgeRule,
  type IntentEdge,
  type IntentGraph,
} from '../packages/sangfor-intent-graph/src/index.js';
import type { IntendedSpec } from '../packages/sangfor-spec/src/index.js';

const observedByDevice: Record<string, Record<string, unknown>> = {
  'dev-a': { 'ha.peerAddress': '10.0.0.2', 'ha.groupId': 'g1', 'vpn.tunnel.peerIp': '203.0.113.9', 'ntp.server': '10.9.9.1' },
  'dev-b': { 'ha.peerAddress': '10.0.0.1', 'ha.groupId': 'g1', 'vpn.tunnel.localIp': '203.0.113.9', 'ntp.server': '10.9.9.2' },
  'dev-c': { 'ha.groupId': 'g2', 'ntp.server': '10.9.9.1' },
};

const haRule: EdgeRule = {
  kind: 'ha-pair',
  derivedFrom: 'inferred',
  confidence: 0.8,
  match: (a, b) =>
    a.observed['ha.groupId'] !== undefined
    && a.observed['ha.groupId'] === b.observed['ha.groupId']
      ? [
        { observedKey: 'ha.groupId', value: a.observed['ha.groupId'] },
      ]
      : null,
};

const vpnRule: EdgeRule = {
  kind: 'vpn-peer',
  derivedFrom: 'inferred',
  confidence: 0.6,
  match: (a, b) =>
    a.observed['vpn.tunnel.peerIp'] !== undefined
    && a.observed['vpn.tunnel.peerIp'] === b.observed['vpn.tunnel.localIp']
      ? [{ observedKey: 'vpn.tunnel.peerIp', value: a.observed['vpn.tunnel.peerIp'] }]
      : null,
};

describe('@sangfor/intent-graph — edge derivation (design 002, D1)', () => {
  it('builds a node per device with its declared product', () => {
    const graph = deriveEdges(observedByDevice, [], { products: { 'dev-a': 'HCI', 'dev-b': 'HCI' } });
    expect(graph.nodes).toEqual([
      { deviceId: 'dev-a', product: 'HCI' },
      { deviceId: 'dev-b', product: 'HCI' },
      { deviceId: 'dev-c', product: 'UNKNOWN' },
    ]);
    expect(graph.edges).toEqual([]);
  });

  it('derives an inferred HA edge with the evidence that produced it', () => {
    const graph = deriveEdges(observedByDevice, [haRule]);
    const haEdges = graph.edges.filter((e) => e.kind === 'ha-pair');
    expect(haEdges).toEqual<IntentEdge[]>([
      {
        kind: 'ha-pair',
        from: 'dev-a',
        to: 'dev-b',
        derivedFrom: 'inferred',
        confidence: 0.8,
        evidence: [{ observedKey: 'ha.groupId', value: 'g1' }],
      },
      {
        kind: 'ha-pair',
        from: 'dev-b',
        to: 'dev-a',
        derivedFrom: 'inferred',
        confidence: 0.8,
        evidence: [{ observedKey: 'ha.groupId', value: 'g1' }],
      },
    ]);
  });

  it('never emits a self-edge and never emits an edge without evidence', () => {
    const graph = deriveEdges(observedByDevice, [haRule, vpnRule]);
    expect(graph.edges.some((e) => e.from === e.to)).toBe(false);
    for (const edge of graph.edges) expect(edge.evidence.length).toBeGreaterThan(0);
  });

  it('applies an injected matcher on tunnel peer-IP equality in the matched direction only', () => {
    const graph = deriveEdges(observedByDevice, [vpnRule]);
    expect(graph.edges).toEqual<IntentEdge[]>([
      {
        kind: 'vpn-peer',
        from: 'dev-a',
        to: 'dev-b',
        derivedFrom: 'inferred',
        confidence: 0.6,
        evidence: [{ observedKey: 'vpn.tunnel.peerIp', value: '203.0.113.9' }],
      },
    ]);
  });

  it('keeps declared edges declared and is deterministic across runs', () => {
    const declaredRule: EdgeRule = { ...haRule, derivedFrom: 'declared', confidence: 1 };
    const first = deriveEdges(observedByDevice, [declaredRule, vpnRule]);
    const second = deriveEdges(observedByDevice, [declaredRule, vpnRule]);
    expect(first).toEqual(second);
    expect(first.edges.filter((e) => e.kind === 'ha-pair').every((e) => e.derivedFrom === 'declared')).toBe(true);
  });

  it('produces no edges when no rule matches', () => {
    expect(deriveEdges({ 'dev-a': { x: 1 }, 'dev-b': { x: 2 } }, [haRule]).edges).toEqual([]);
  });
});

const ntpSpec: IntendedSpec = {
  id: 'cross-ha-ntp',
  product: 'HCI',
  items: [
    {
      id: 'ntp-match',
      capabilityId: 'ha.consistency',
      label: 'HA 쌍의 NTP 서버가 동일해야 함',
      observedKey: 'peer.ntp.server',
      op: 'eq',
      expected: '10.9.9.1',
      severity: 'must',
      source: { manual: 'HCI Admin Guide', section: 'HA' },
    },
  ],
};

const keyMap = { 'peer.ntp.server': { device: 'to' as const, observedKey: 'ntp.server' } };

describe('@sangfor/intent-graph — cross-device spec assembly (design 002, D1)', () => {
  const declaredEdge: IntentEdge = {
    kind: 'ha-pair',
    from: 'dev-a',
    to: 'dev-c',
    derivedFrom: 'declared',
    confidence: 1,
    evidence: [{ observedKey: 'ha.groupId', value: 'g1' }],
  };
  const inferredEdge: IntentEdge = { ...declaredEdge, derivedFrom: 'inferred', confidence: 0.8 };

  it('assembles one observed record across the edge endpoints', () => {
    const assembled = assembleCrossDeviceObserved(declaredEdge, observedByDevice, keyMap);
    expect(assembled).toEqual({ observed: { 'peer.ntp.server': '10.9.9.1' }, edgeInferred: false });
  });

  it('marks the assembled record when the edge was inferred', () => {
    expect(assembleCrossDeviceObserved(inferredEdge, observedByDevice, keyMap).edgeInferred).toBe(true);
  });

  it('omits a key whose source device or observedKey is missing rather than inventing it', () => {
    const missing = assembleCrossDeviceObserved(
      declaredEdge,
      observedByDevice,
      { 'peer.ntp.server': { device: 'to', observedKey: 'ntp.absent' }, 'peer.missing': { device: 'from', observedKey: 'nope' } },
    );
    expect(missing.observed).toEqual({});
  });

  it('PASSes a declared edge through the existing evaluateSpec engine', () => {
    const assembled = assembleCrossDeviceObserved(declaredEdge, observedByDevice, keyMap);
    const result = evaluateCrossDeviceSpec(ntpSpec, assembled);
    expect(result.items[0]?.verdict).toBe('PASS');
    expect(result.summary.pass).toBe(1);
    expect(result.ok).toBe(true);
  });

  it('demotes every would-be PASS to INDETERMINATE when the edge is inferred', () => {
    const assembled = assembleCrossDeviceObserved(inferredEdge, observedByDevice, keyMap);
    const result = evaluateCrossDeviceSpec(ntpSpec, assembled);
    expect(result.items[0]?.verdict).toBe('INDETERMINATE');
    expect(result.items[0]?.category).toBe('indeterminate');
    expect(result.items[0]?.reason).toContain('inferred-edge');
    expect(result.summary.pass).toBe(0);
    expect(result.summary.indeterminate).toBe(1);
    expect(result.ok).toBe(false);
  });

  it('is demotion-only — an inferred edge never masks a FAIL', () => {
    const mismatchEdge: IntentEdge = { ...inferredEdge, to: 'dev-b' };
    const assembled = assembleCrossDeviceObserved(mismatchEdge, observedByDevice, keyMap);
    expect(assembled.observed).toEqual({ 'peer.ntp.server': '10.9.9.2' });
    const result = evaluateCrossDeviceSpec(ntpSpec, assembled);
    expect(result.items[0]?.verdict).toBe('FAIL');
    expect(result.items[0]?.category).toBe('misconfiguration');
    expect(result.summary.fail).toBe(1);
  });

  it('carries the graph node/edge types it advertises', () => {
    const graph: IntentGraph = deriveEdges(observedByDevice, [haRule]);
    expect(graph.nodes.map((n) => n.deviceId)).toEqual(['dev-a', 'dev-b', 'dev-c']);
  });
});
