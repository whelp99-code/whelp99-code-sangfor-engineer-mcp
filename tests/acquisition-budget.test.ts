import { describe, expect, it } from 'vitest';
import {
  planCalls,
  type ApiBudget,
  type CallLedger,
  type PlannedCall,
} from '../packages/sangfor-acquisition/src/index.js';

const budget: ApiBudget = { maxConcurrent: 2, maxPerMinute: 5 };
const now = '2026-08-18T06:00:00.000Z';

const call = (id: string): PlannedCall => ({ id, observedKey: `k.${id}`, endpoint: `GET /api/${id}` });

const ledger = (over: Partial<CallLedger> = {}): CallLedger => ({
  inFlight: 0,
  recentCallsAt: [],
  ...over,
});

describe('@sangfor/acquisition — per-device API budget manager (design 002, A5)', () => {
  it('allows everything when the budget is untouched and the request fits', () => {
    const plan = planCalls({ deviceId: 'dev-1', requested: [call('a'), call('b')], budget, ledger: ledger(), now });
    expect(plan.allowed.map((c) => c.id)).toEqual(['a', 'b']);
    expect(plan.deferred).toEqual([]);
    expect(plan.loadRecord).toEqual({ deviceId: 'dev-1', allowedCount: 2, deferredCount: 0, at: now });
  });

  it('never exceeds maxConcurrent, deferring the overflow in request order', () => {
    const plan = planCalls({
      deviceId: 'dev-1',
      requested: [call('a'), call('b'), call('c')],
      budget,
      ledger: ledger({ inFlight: 1 }),
      now,
    });
    expect(plan.allowed.map((c) => c.id)).toEqual(['a']);
    expect(plan.deferred.map((c) => c.id)).toEqual(['b', 'c']);
    expect(plan.loadRecord).toEqual({ deviceId: 'dev-1', allowedCount: 1, deferredCount: 2, at: now });
  });

  it('never exceeds maxPerMinute, counting only calls inside the trailing minute', () => {
    const inWindow = ['2026-08-18T05:59:30.000Z', '2026-08-18T05:59:45.000Z', '2026-08-18T05:59:59.000Z'];
    const expired = ['2026-08-18T05:58:00.000Z', '2026-08-18T05:30:00.000Z'];
    const plan = planCalls({
      deviceId: 'dev-1',
      requested: [call('a'), call('b'), call('c')],
      budget,
      ledger: ledger({ recentCallsAt: [...expired, ...inWindow] }),
      now,
    });
    expect(plan.allowed.map((c) => c.id)).toEqual(['a', 'b']);
    expect(plan.deferred.map((c) => c.id)).toEqual(['c']);
  });

  it('applies the tighter of the two limits', () => {
    const plan = planCalls({
      deviceId: 'dev-1',
      requested: [call('a'), call('b'), call('c'), call('d')],
      budget: { maxConcurrent: 3, maxPerMinute: 4 },
      ledger: ledger({ inFlight: 1, recentCallsAt: ['2026-08-18T05:59:50.000Z', '2026-08-18T05:59:55.000Z'] }),
      now,
    });
    // concurrency allows 2, rate allows 2 -> 2
    expect(plan.allowed.map((c) => c.id)).toEqual(['a', 'b']);
    expect(plan.deferred.map((c) => c.id)).toEqual(['c', 'd']);
  });

  it('defers everything and still emits a load record when the budget is exhausted', () => {
    const plan = planCalls({
      deviceId: 'dev-2',
      requested: [call('a'), call('b')],
      budget,
      ledger: ledger({ inFlight: 2, recentCallsAt: [] }),
      now,
    });
    expect(plan.allowed).toEqual([]);
    expect(plan.deferred.map((c) => c.id)).toEqual(['a', 'b']);
    expect(plan.loadRecord).toEqual({ deviceId: 'dev-2', allowedCount: 0, deferredCount: 2, at: now });
  });

  it('emits a load record even for an empty request so the ledger has no holes', () => {
    const plan = planCalls({ deviceId: 'dev-1', requested: [], budget, ledger: ledger(), now });
    expect(plan.loadRecord).toEqual({ deviceId: 'dev-1', allowedCount: 0, deferredCount: 0, at: now });
  });

  it('treats an unparseable or over-committed ledger as no headroom rather than free capacity', () => {
    const unparseable = planCalls({
      deviceId: 'dev-1',
      requested: [call('a')],
      budget,
      ledger: ledger({ recentCallsAt: ['not-a-date', 'not-a-date', 'not-a-date', 'not-a-date', 'not-a-date'] }),
      now,
    });
    expect(unparseable.allowed).toEqual([]);
    expect(unparseable.deferred.map((c) => c.id)).toEqual(['a']);

    const overCommitted = planCalls({
      deviceId: 'dev-1',
      requested: [call('a')],
      budget,
      ledger: ledger({ inFlight: 9 }),
      now,
    });
    expect(overCommitted.allowed).toEqual([]);
  });

  it('refuses a nonsensical budget instead of silently collecting unlimited', () => {
    for (const bad of [{ maxConcurrent: 0, maxPerMinute: 5 }, { maxConcurrent: -1, maxPerMinute: 5 }, { maxConcurrent: 2, maxPerMinute: 0 }]) {
      const plan = planCalls({ deviceId: 'dev-1', requested: [call('a')], budget: bad, ledger: ledger(), now });
      expect(plan.allowed).toEqual([]);
      expect(plan.deferred.map((c) => c.id)).toEqual(['a']);
      expect(plan.loadRecord.allowedCount).toBe(0);
    }
  });

  it('is pure — neither the ledger nor the requested list is mutated', () => {
    const requested = [call('a'), call('b'), call('c')];
    const start = ledger({ inFlight: 1, recentCallsAt: ['2026-08-18T05:59:30.000Z'] });
    planCalls({ deviceId: 'dev-1', requested, budget, ledger: start, now });
    expect(start).toEqual({ inFlight: 1, recentCallsAt: ['2026-08-18T05:59:30.000Z'] });
    expect(requested.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('is deterministic for identical inputs', () => {
    const input = { deviceId: 'dev-1', requested: [call('a'), call('b'), call('c')], budget, ledger: ledger({ inFlight: 1 }), now };
    expect(planCalls(input)).toEqual(planCalls(input));
  });
});
