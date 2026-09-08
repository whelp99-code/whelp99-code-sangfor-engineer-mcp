import { describe, expect, it } from 'vitest';
import { parseAuthorityCutoverCli } from '../scripts/blro-migrate-authority.js';
import {
  AuthorityCutoverError,
  CutoverState,
  parseCutoverRecord,
  canonicalRecordSet,
  transitionCutover,
  LOCAL_WRITER_REFS,
  verifyLocalWriterCoverage,
  type CutoverAggregateState,
} from '../packages/sangfor-authority/src/cutover/index.js';

const base = (): CutoverAggregateState => ({
  projectId: 'project-a',
  aggregate: 'registry_services',
  state: CutoverState.LOCAL_PRIMARY,
  epoch: 0,
  revision: 0,
  sourceHighWaterMark: null,
  sourceDigest: null,
  targetDigest: null,
  localWriteFencedAt: null,
});

describe('authority cutover machine', () => {
  it('Given a strict transfer record, When parsed and canonicalized, Then its stable key and provenance determine one digest', () => {
    const record = parseCutoverRecord({
      key: 'dev-1',
      payload: { product: 'HCI', name: 'edge' },
      provenance: {
        tenantId: 'tenant-a', projectId: 'project-a', sourceRoot: '/source',
        source: 'data/registry/devices.json', ordinal: 0, sourceSha256: 'a'.repeat(64) },
    });

    expect(canonicalRecordSet([record])).toMatchObject({ keys: ['dev-1'], count: 1 });
    expect(canonicalRecordSet([record]).digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('Given unknown or invalid transfer fields, When parsed, Then it fails closed', () => {
    expect(() => parseCutoverRecord({
      key: 'dev-1', payload: {}, extra: true,
      provenance: { tenantId: 't', projectId: 'p', sourceRoot: '/source', source: 'devices.json', ordinal: 0, sourceSha256: 'a'.repeat(64) },
    })).toThrow(AuthorityCutoverError);
    expect(() => parseCutoverRecord({
      key: 'dev-1', payload: {},
      provenance: { tenantId: 't', projectId: 'p', sourceRoot: '/source', source: 'devices.json', ordinal: -1, sourceSha256: 'bad' },
    })).toThrow(AuthorityCutoverError);
  });

  it('Given matching source and target checkpoints, When advancing, Then every state is explicit and promotion increments epoch', () => {
    const backfilling = transitionCutover(base(), { kind: 'START_BACKFILL', highWaterMark: 'hwm-1' });
    const shadow = transitionCutover(backfilling, { kind: 'VERIFY_BACKFILL', sourceDigest: 'a'.repeat(64), targetDigest: 'a'.repeat(64) });
    const frozen = transitionCutover(shadow, { kind: 'FREEZE', at: '2026-08-26T00:00:00.000Z' });
    const promoted = transitionCutover(frozen, { kind: 'PROMOTE' });

    expect([backfilling.state, shadow.state, frozen.state, promoted.state]).toEqual([
      CutoverState.BACKFILLING, CutoverState.SHADOW_READING, CutoverState.FROZEN, CutoverState.POSTGRES_PRIMARY,
    ]);
    expect(promoted).toMatchObject({ epoch: 1, localWriteFencedAt: '2026-08-26T00:00:00.000Z' });
  });

  it('Given digest mismatch or a frozen aggregate, When verifying or rolling back, Then it refuses without state change', () => {
    const backfilling = transitionCutover(base(), { kind: 'START_BACKFILL', highWaterMark: 'hwm-1' });
    expect(() => transitionCutover(backfilling, {
      kind: 'VERIFY_BACKFILL', sourceDigest: 'a'.repeat(64), targetDigest: 'b'.repeat(64),
    })).toThrow('CUTOVER_PARITY_MISMATCH');
    const shadow = transitionCutover(backfilling, {
      kind: 'VERIFY_BACKFILL', sourceDigest: 'a'.repeat(64), targetDigest: 'a'.repeat(64),
    });
    const frozen = transitionCutover(shadow, { kind: 'FREEZE', at: '2026-08-26T00:00:00.000Z' });
    expect(() => transitionCutover(frozen, { kind: 'ROLLBACK' })).toThrow('CUTOVER_ROLLBACK_REFUSED');
  });

  it('Given a stale revision or illegal jump, When applying CAS semantics, Then it fails closed', () => {
    expect(() => transitionCutover({ ...base(), revision: 2 }, {
      kind: 'START_BACKFILL', highWaterMark: 'hwm-1', expectedRevision: 1,
    })).toThrow('CUTOVER_STALE_REVISION');
    expect(() => transitionCutover(base(), { kind: 'PROMOTE' })).toThrow('CUTOVER_STATE_CONFLICT');
  });

  it('Given the canonical compiler census, When writer coverage is checked, Then all 22 symbols are fenced', () => {
    expect(LOCAL_WRITER_REFS).toHaveLength(22);
    expect(() => verifyLocalWriterCoverage(new URL('..', import.meta.url).pathname)).not.toThrow();
  }, 15_000);

  it('Given CLI arguments, When scope or apply intent is ambiguous, Then parsing refuses', () => {
    expect(parseAuthorityCutoverCli(['status', '--project', 'p', '--aggregate', 'registry_services']))
      .toMatchObject({ command: 'status', apply: false });
    expect(() => parseAuthorityCutoverCli(['rollback', '--project', 'p', '--aggregate', 'registry_services']))
      .toThrow('CUTOVER_CLI_APPLY_REQUIRED');
    expect(() => parseAuthorityCutoverCli(['status', '--project', 'p', '--aggregate', 'invented']))
      .toThrow('CUTOVER_AGGREGATE_UNSUPPORTED');
    expect(() => parseAuthorityCutoverCli(['status', '--project', 'p', '--aggregate', 'registry_services', '--surprise']))
      .toThrow('CUTOVER_CLI_UNKNOWN_ARGUMENT');
    const exact = ['--project', 'p', '--aggregate', 'evals', '--tenant', 't', '--actor', 'a', '--source-root', '/tmp/source', '--source-files', 'eval-cases.jsonl', '--expected-revision', '0', '--expected-epoch', '0', '--apply'];
    for (const command of ['backfill', 'shadow', 'freeze', 'promote', 'reconcile'] as const) {
      expect(() => parseAuthorityCutoverCli([command, ...exact]), command).toThrow('CUTOVER_CLI_EXPECTATION_REQUIRED');
    }
    expect(() => parseAuthorityCutoverCli(['rollback', ...exact])).toThrow('CUTOVER_CLI_EXPECTATION_REQUIRED');
    expect(() => parseAuthorityCutoverCli(['backfill', ...exact, '--expected-revision', '0', '--expected-epoch', '0', '--expected-hwm', 'h', '--expected-source-digest', 'a'.repeat(64), '--expected-target-digest', 'a'.repeat(64), '--expected-target-digest', 'a'.repeat(64)]))
      .toThrow('CUTOVER_CLI_DUPLICATE_ARGUMENT');
  });
});
