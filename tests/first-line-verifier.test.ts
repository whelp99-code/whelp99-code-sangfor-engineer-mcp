import { describe, expect, it } from 'vitest';
import {
  verifyReportClaims,
  type VerifiableReport,
} from '../packages/sangfor-first-line/src/index.js';

/**
 * Design 002, block F4 — deterministic adversarial verification.
 *
 * Before a report leaves the agent it must prove that every RAG citation, every
 * asserted fact and every rollback target actually exists in the corpus,
 * snapshot and device inventory the caller injects. Any failure blocks the
 * draft; nothing here does IO.
 */

const report: VerifiableReport = {
  reportId: 'rep-1',
  deviceId: 'dev-1',
  citations: [{ chunkId: 'chunk-a' }, { chunkId: 'chunk-b' }],
  facts: [
    { key: 'firmware', value: '8.0.75' },
    { key: 'ntpServer', value: '10.0.0.1' },
  ],
  rollback: { targets: ['ntp.server'] },
};

const corpus = {
  ragChunkIds: new Set(['chunk-a', 'chunk-b', 'chunk-c']),
  snapshotFacts: { firmware: '8.0.75', ntpServer: '10.0.0.1', mtu: 9000 } as Record<string, unknown>,
  deviceObjects: new Set(['ntp.server', 'dns.server']),
};

describe('@sangfor/first-line — verifyReportClaims (F4)', () => {
  it('passes a report whose every claim resolves', () => {
    const result = verifyReportClaims({ report, ...corpus });

    expect(result.status).toBe('verified');
    expect(result.checks.map((c) => [c.check, c.pass])).toEqual([
      ['citation-exists', true],
      ['citation-exists', true],
      ['fact-exists', true],
      ['fact-exists', true],
      ['rollback-target-exists', true],
    ]);
    expect(result.checks.every((c) => typeof c.detail === 'string' && c.detail.length > 0)).toBe(
      true,
    );
  });

  it('blocks the draft on a hallucinated citation', () => {
    const result = verifyReportClaims({
      ...corpus,
      report: { ...report, citations: [{ chunkId: 'chunk-a' }, { chunkId: 'chunk-ghost' }] },
    });

    expect(result.status).toBe('draft-blocked');
    const failed = result.checks.filter((c) => !c.pass);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.check).toBe('citation-exists');
    expect(failed[0]?.detail).toContain('chunk-ghost');
  });

  it('blocks the draft on a fact that is absent from the snapshot', () => {
    const result = verifyReportClaims({
      ...corpus,
      report: { ...report, facts: [{ key: 'bgpAsn', value: 65000 }] },
    });

    expect(result.status).toBe('draft-blocked');
    expect(result.checks.filter((c) => !c.pass)).toEqual([
      { check: 'fact-exists', pass: false, detail: 'fact "bgpAsn" is absent from the snapshot' },
    ]);
  });

  it('blocks the draft on a fact whose value contradicts the snapshot', () => {
    const result = verifyReportClaims({
      ...corpus,
      report: { ...report, facts: [{ key: 'firmware', value: '9.9.99' }] },
    });

    expect(result.status).toBe('draft-blocked');
    const failed = result.checks.filter((c) => !c.pass);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.detail).toContain('firmware');
    expect(failed[0]?.detail).toContain('8.0.75');
  });

  it('compares fact values structurally, not by reference', () => {
    const result = verifyReportClaims({
      ...corpus,
      snapshotFacts: { interfaces: [{ name: 'eth0', mtu: 9000 }] },
      report: { ...report, citations: [], facts: [{ key: 'interfaces', value: [{ mtu: 9000, name: 'eth0' }] }], rollback: { targets: [] } },
    });

    expect(result.status).toBe('verified');
  });

  it('blocks the draft on a rollback target that does not exist on the device', () => {
    const result = verifyReportClaims({
      ...corpus,
      report: { ...report, rollback: { targets: ['ntp.server', 'ghost.object'] } },
    });

    expect(result.status).toBe('draft-blocked');
    const failed = result.checks.filter((c) => !c.pass);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ check: 'rollback-target-exists', pass: false });
    expect(failed[0]?.detail).toContain('ghost.object');
  });

  it('reports every failure, not just the first', () => {
    const result = verifyReportClaims({
      ...corpus,
      report: {
        ...report,
        citations: [{ chunkId: 'ghost-1' }],
        facts: [{ key: 'ghost-fact', value: 1 }],
        rollback: { targets: ['ghost-target'] },
      },
    });

    expect(result.status).toBe('draft-blocked');
    expect(result.checks.map((c) => c.check)).toEqual([
      'citation-exists',
      'fact-exists',
      'rollback-target-exists',
    ]);
    expect(result.checks.every((c) => !c.pass)).toBe(true);
  });

  it('is deterministic — the same input yields byte-identical output', () => {
    const a = verifyReportClaims({ report, ...corpus });
    const b = verifyReportClaims({ report, ...corpus });

    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('verifies a report with nothing to check rather than inventing a failure', () => {
    const result = verifyReportClaims({
      ...corpus,
      report: { reportId: 'rep-empty', deviceId: 'dev-1', citations: [], facts: [] },
    });

    expect(result).toEqual({ reportId: 'rep-empty', status: 'verified', checks: [] });
  });
});
