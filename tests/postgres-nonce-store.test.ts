import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgresSingleUseNonceStore } from '../packages/sangfor-approval/src/postgres-nonce-store.js';

/**
 * D5 step 1 — the single-use approval nonce moves to the database.
 *
 * A JSON file makes "single use" a race the moment BLRO has more than one
 * replica: two processes read the same prior state, each appends, and the same
 * nonce is consumed twice. Postgres gives what a file cannot — a unique
 * constraint plus a transactional consume.
 *
 * These tests need a real database. They are skipped (not silently passed) when
 * DATABASE_URL is unset, because a green result from a suite that never touched
 * a database would be a false assurance about a control that gates real device
 * mutation.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

const PROJECT_A = 'proj-a';
const PROJECT_B = 'proj-b';

function future(minutes = 60): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

describeDb('PostgresSingleUseNonceStore', () => {
  let store: PostgresSingleUseNonceStore;

  beforeAll(() => {
    store = new PostgresSingleUseNonceStore({ connectionString: DATABASE_URL as string });
  });

  afterAll(async () => {
    await store.close();
  });

  beforeEach(async () => {
    await store.purgeForTest();
  });

  it('consumes an unused nonce exactly once', async () => {
    const first = await store.consume(PROJECT_A, 'nonce-1', future());
    expect(first.ok).toBe(true);
  });

  it('refuses a replayed nonce with the caller-visible prefix', async () => {
    await store.consume(PROJECT_A, 'nonce-replay', future());
    const second = await store.consume(PROJECT_A, 'nonce-replay', future());
    expect(second.ok).toBe(false);
    expect(second.reason ?? '').toContain('approval nonce already used:');
  });

  it('refuses an already-expired nonce', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const result = await store.consume(PROJECT_A, 'nonce-expired', past);
    expect(result.ok).toBe(false);
    expect(result.reason ?? '').toMatch(/expired/i);
  });

  it('refuses malformed input rather than storing it', async () => {
    expect((await store.consume(PROJECT_A, '', future())).ok).toBe(false);
    expect((await store.consume(PROJECT_A, 'n', 'not-a-date')).ok).toBe(false);
    expect((await store.consume('', 'n', future())).ok).toBe(false);
  });

  it('scopes a nonce to its project: the same value is independent elsewhere', async () => {
    const inA = await store.consume(PROJECT_A, 'shared-value', future());
    const inB = await store.consume(PROJECT_B, 'shared-value', future());
    expect(inA.ok).toBe(true);
    expect(inB.ok, 'a nonce consumed in project A must not block project B').toBe(true);
  });

  it('elects exactly one winner when two consumers race the same nonce', async () => {
    // The reason this migration exists. With the JSON file both callers could
    // read the same prior state and both believe they won.
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () => store.consume(PROJECT_A, 'race-nonce', future())),
    );
    const winners = attempts.filter((r) => r.ok);
    expect(winners, `expected exactly 1 winner, got ${winners.length}`).toHaveLength(1);
  });

  it('fails closed when the database is unreachable', async () => {
    const broken = new PostgresSingleUseNonceStore({
      connectionString: 'postgresql://nobody:nobody@127.0.0.1:1/nonexistent',
    });
    try {
      const result = await broken.consume(PROJECT_A, 'nonce-unreachable', future());
      expect(result.ok, 'an unreachable store must refuse, never allow').toBe(false);
      expect(result.reason ?? '').toMatch(/unavailable|refus|ECONNREFUSED|connect/i);
    } finally {
      await broken.close();
    }
  });

  it('never echoes the connection password in a failure reason', async () => {
    const secret = 'sup3rs3cretpw';
    const broken = new PostgresSingleUseNonceStore({
      connectionString: `postgresql://user:${secret}@127.0.0.1:1/nonexistent`,
    });
    try {
      const result = await broken.consume(PROJECT_A, 'nonce-secret', future());
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(secret);
    } finally {
      await broken.close();
    }
  });
});
