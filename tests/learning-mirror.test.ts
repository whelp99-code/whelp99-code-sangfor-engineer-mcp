import { testFileLocalWriteAuthority, testLocalWriteAuthority } from './helpers/local-write-authority.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  StrategyStoreManager,
  syncStrategyMirror,
  validateMirrorEvent,
  type LearningMirrorAdapter,
} from '../packages/sangfor-learning-strategy/src/index.js';

const CONTENT = 'a'.repeat(64);

describe('PR-010 local outbox mirror', () => {
  let root: string;
  let manager: StrategyStoreManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'learning-mirror-'));
    manager = new StrategyStoreManager(join(root, 'strategy.json'), testFileLocalWriteAuthority('learning_strategy_lifecycle', join(root, 'strategy.json')));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function seed(): Promise<void> {
    const store = manager.addRevision(manager.createStrategy('strategy-1'), {
      strategyId: 'strategy-1', state: 'draft', contentHash: CONTENT,
    });
    expect(await manager.commit(store, 0)).toEqual({ ok: true });
  }

  it('creates a sanitized pending outbox event in the same local generation commit', async () => {
    await seed();
    const loaded = manager.load()!;
    expect(loaded.schemaVersion).toBe(1);
    expect(loaded.mirrorOutbox).toHaveLength(1);
    expect(loaded.mirrorOutbox[0]).toMatchObject({
      eventType: 'strategy_revision', status: 'pending', attempts: 0,
      metadata: { strategyId: 'strategy-1', state: 'draft', contentDigest: CONTENT },
    });
    const persisted = readFileSync(join(root, 'strategy.json'), 'utf8');
    expect(persisted).not.toMatch(/evidenceFile|bundlePath|capturePayload|rawPayload|password|secret|token|authorization|cookie/iu);
  });

  it('upserts once by event ID and records an idempotent receipt', async () => {
    await seed();
    const seen = new Set<string>();
    let calls = 0;
    const adapter: LearningMirrorAdapter = {
      async upsert(event) {
        calls += 1;
        seen.add(event.eventId);
        return { mirroredAt: '2026-07-28T00:00:00.000Z' };
      },
    };
    const first = await syncStrategyMirror(manager, adapter, new Date('2099-07-28T00:00:01.000Z'));
    expect(first).toMatchObject({ attempted: 1, mirrored: 1, failed: 0, committed: true });
    const second = await syncStrategyMirror(manager, adapter, new Date('2099-07-28T00:00:02.000Z'));
    expect(second).toMatchObject({ attempted: 0, mirrored: 0, committed: false });
    expect(calls).toBe(1);
    expect(seen.size).toBe(1);
    expect(manager.load()!.mirrorReceipts).toHaveLength(1);
  });

  it('keeps local success with pending exponential retry when the DB adapter is unavailable', async () => {
    await seed();
    const before = manager.load()!;
    const result = await syncStrategyMirror(manager, { async upsert() { throw new Error('MIRROR_DB_UNAVAILABLE'); } },
      new Date('2099-07-28T00:00:01.000Z'));
    expect(result).toMatchObject({ attempted: 1, mirrored: 0, failed: 1, pending: 1, committed: true });
    const after = manager.load()!;
    expect(after.generations.flatMap((generation) => generation.revisions).length)
      .toBeGreaterThanOrEqual(before.generations.flatMap((generation) => generation.revisions).length);
    expect(after.mirrorOutbox[0]).toMatchObject({ status: 'pending', attempts: 1, lastErrorCode: 'MIRROR_DB_UNAVAILABLE' });
    expect(after.mirrorOutbox[0]!.nextAttemptAt).toBe('2099-07-28T00:00:02.000Z');
  });

  it('moves the tenth failed attempt to DLQ without deleting local records', async () => {
    await seed();
    const store = manager.load()!;
    store.mirrorOutbox[0]!.attempts = 9;
    store.mirrorOutbox[0]!.nextAttemptAt = '2026-07-28T00:00:00.000Z';
    expect(await manager.commit(store, store.currentGeneration)).toEqual({ ok: true });
    const result = await syncStrategyMirror(manager, { async upsert() { throw new Error('DB_DOWN'); } },
      new Date('2026-07-28T00:00:01.000Z'));
    expect(result).toMatchObject({ attempted: 1, failed: 0, dlq: 1, pending: 0 });
    expect(manager.load()!.mirrorOutbox[0]).toMatchObject({ status: 'dlq', attempts: 10, lastErrorCode: 'DB_DOWN' });
  });

  it('rejects path/payload/secret metadata and malformed digests', () => {
    const base = {
      eventId: 'event-1', eventType: 'run', occurredAt: '2026-07-28T00:00:00.000Z',
      payloadDigest: 'a'.repeat(64), status: 'pending', attempts: 0,
      nextAttemptAt: '2026-07-28T00:00:00.000Z', metadata: { status: 'complete' },
    } as const;
    expect(validateMirrorEvent(base)).toMatchObject({ eventId: 'event-1' });
    for (const metadata of [{ bundlePath: '/tmp/x' }, { payload: 'raw' }, { apiToken: 'x' }]) {
      expect(() => validateMirrorEvent({ ...base, metadata })).toThrow(/INVALID_MIRROR_EVENT/u);
    }
    expect(() => validateMirrorEvent({ ...base, payloadDigest: 'bad' })).toThrow(/INVALID_MIRROR_EVENT/u);
  });
});
