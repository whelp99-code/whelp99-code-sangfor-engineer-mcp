import { describe, expect, it } from 'vitest';
import { summarize } from '../apps/control-tower/src/api.js';
import { summarize as summarizeFromModule } from '../apps/control-tower/src/run-summary.js';

describe('tower run result summary line', () => {
  it('serves the same summary function through the composition root and its module', () => {
    // Given the re-exported name every caller of `api.js` binds.
    // When it is compared with the extracted module's own export.
    // Then the split rebound the name without introducing a second implementation.
    expect(summarize).toBe(summarizeFromModule);
  });

  it('aggregates a multi-evaluation payload into one ok/pass/fail line', () => {
    // Given a bridge payload wrapping two evaluations, one of them failing.
    const payload = {
      evaluations: [
        { ok: true, summary: { pass: 3, fail: 0 } },
        { ok: false, summary: { pass: 1, fail: 2 } },
      ],
    };

    // When the run summary line is derived.
    const line = summarize(payload);

    // Then the counts are summed and ok is the conjunction.
    expect(line).toBe('ok=false pass=4 fail=2');
  });

  it('prefers a directly shaped evaluation over its wrappers', () => {
    // Given a payload that is itself an evaluation and also carries a wrapper.
    const payload = { ok: true, summary: { pass: 7, fail: 0 }, evaluation: { ok: false, summary: { pass: 0, fail: 9 } } };

    // When the run summary line is derived.
    const line = summarize(payload);

    // Then the direct shape wins.
    expect(line).toBe('ok=true pass=7 fail=0');
  });

  it('reports an advisor error payload as its own first line', () => {
    // Given an advisor error payload rather than an evaluation.
    // When the run summary line is derived.
    const line = summarize({ error: 'device unreachable' });

    // Then the error text is carried, not the JSON dump.
    expect(line).toBe('error: device unreachable');
  });

  it('caps an unrecognized payload at the stored summary budget', () => {
    // Given an unrecognized payload far longer than the summary budget.
    // When the run summary line is derived.
    const line = summarize({ note: 'x'.repeat(500) });

    // Then it is truncated to the 150-character JSON slice the store accepts.
    expect(line.length).toBe(150);
    expect(line.startsWith('{"note":"xxx')).toBe(true);
  });

  it('falls back to the stringified value when the payload cannot be serialized', () => {
    // Given a payload with a cycle, which JSON.stringify refuses.
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;

    // When the run summary line is derived.
    const line = summarize(cyclic);

    // Then the summary degrades to the coerced string instead of throwing.
    expect(line).toBe('[object Object]');
  });
});
