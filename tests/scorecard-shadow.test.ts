import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  activationDecision,
  recordHumanAction,
  recordShadowRun,
  shadowAgreement,
  type ShadowMatcher,
} from '../packages/sangfor-scorecard/src/index.js';

/** Two actions agree when they name the same verb on the same target. */
const sameAction: ShadowMatcher = (automated, human) =>
  automated.action === human.action && automated.target === human.target;

describe('@sangfor/scorecard — shadow mode (design 002, block G2)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'scorecard-shadow-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function seedPair(findingId: string, automated: Record<string, unknown>, human: Record<string, unknown>): void {
    recordShadowRun(dir, {
      automationId: 'auto-close-ntp-drift',
      findingId,
      automatedAction: automated,
      at: '2026-08-01T00:00:00.000Z',
    });
    recordHumanAction(dir, {
      automationId: 'auto-close-ntp-drift',
      findingId,
      humanAction: human,
      at: '2026-08-01T01:00:00.000Z',
    });
  }

  it('appends each shadow run as one JSONL record carrying its own id', () => {
    const first = recordShadowRun(dir, {
      automationId: 'auto-close-ntp-drift',
      findingId: 'f-1',
      automatedAction: { action: 'close', target: 'f-1' },
      at: '2026-08-01T00:00:00.000Z',
    });
    const second = recordShadowRun(dir, {
      automationId: 'auto-close-ntp-drift',
      findingId: 'f-2',
      automatedAction: { action: 'escalate', target: 'f-2' },
      at: '2026-08-01T00:05:00.000Z',
    });

    expect(first.id).not.toBe(second.id);
    const lines = readFileSync(join(dir, 'shadow-runs.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({
      id: first.id,
      kind: 'shadow-run',
      automationId: 'auto-close-ntp-drift',
      findingId: 'f-1',
      automatedAction: { action: 'close', target: 'f-1' },
      at: '2026-08-01T00:00:00.000Z',
    });
    expect(JSON.parse(lines[1]).findingId).toBe('f-2');
  });

  it('appends human actions to their own ledger file', () => {
    const entry = recordHumanAction(dir, {
      automationId: 'auto-close-ntp-drift',
      findingId: 'f-1',
      humanAction: { action: 'close', target: 'f-1' },
      at: '2026-08-01T01:00:00.000Z',
    });
    const lines = readFileSync(join(dir, 'human-actions.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      id: entry.id,
      kind: 'human-action',
      automationId: 'auto-close-ntp-drift',
      findingId: 'f-1',
      humanAction: { action: 'close', target: 'f-1' },
      at: '2026-08-01T01:00:00.000Z',
    });
  });

  it('compares only findings where both a shadow run and a human action exist', () => {
    seedPair('f-1', { action: 'close', target: 'f-1' }, { action: 'close', target: 'f-1' });
    seedPair('f-2', { action: 'close', target: 'f-2' }, { action: 'escalate', target: 'f-2' });
    // Shadow ran but no human ever acted — not comparable, must not inflate the rate.
    recordShadowRun(dir, {
      automationId: 'auto-close-ntp-drift',
      findingId: 'f-3',
      automatedAction: { action: 'close', target: 'f-3' },
      at: '2026-08-01T00:10:00.000Z',
    });
    // Human acted with no shadow run — also not comparable.
    recordHumanAction(dir, {
      automationId: 'auto-close-ntp-drift',
      findingId: 'f-4',
      humanAction: { action: 'close', target: 'f-4' },
      at: '2026-08-01T00:20:00.000Z',
    });

    expect(shadowAgreement(dir, 'auto-close-ntp-drift', sameAction)).toEqual({
      automationId: 'auto-close-ntp-drift',
      compared: 2,
      agreed: 1,
      agreementRate: 0.5,
      disagreements: [{ findingId: 'f-2', automatedAction: { action: 'close', target: 'f-2' }, humanAction: { action: 'escalate', target: 'f-2' } }],
    });
  });

  it('scopes agreement to one automation id and ignores other automations in the same ledger', () => {
    seedPair('f-1', { action: 'close', target: 'f-1' }, { action: 'close', target: 'f-1' });
    recordShadowRun(dir, {
      automationId: 'other-automation',
      findingId: 'f-9',
      automatedAction: { action: 'close', target: 'f-9' },
      at: '2026-08-01T00:00:00.000Z',
    });
    recordHumanAction(dir, {
      automationId: 'other-automation',
      findingId: 'f-9',
      humanAction: { action: 'escalate', target: 'f-9' },
      at: '2026-08-01T01:00:00.000Z',
    });

    const agreement = shadowAgreement(dir, 'auto-close-ntp-drift', sameAction);
    expect(agreement.compared).toBe(1);
    expect(agreement.agreed).toBe(1);
    expect(agreement.agreementRate).toBe(1);
  });

  it('reports an empty ledger as zero compared and a zero rate, never NaN', () => {
    expect(shadowAgreement(dir, 'auto-close-ntp-drift', sameAction)).toEqual({
      automationId: 'auto-close-ntp-drift',
      compared: 0,
      agreed: 0,
      agreementRate: 0,
      disagreements: [],
    });
  });

  it('uses the latest human action per finding when a human acted twice', () => {
    recordShadowRun(dir, {
      automationId: 'auto-close-ntp-drift',
      findingId: 'f-1',
      automatedAction: { action: 'close', target: 'f-1' },
      at: '2026-08-01T00:00:00.000Z',
    });
    recordHumanAction(dir, {
      automationId: 'auto-close-ntp-drift',
      findingId: 'f-1',
      humanAction: { action: 'escalate', target: 'f-1' },
      at: '2026-08-01T01:00:00.000Z',
    });
    recordHumanAction(dir, {
      automationId: 'auto-close-ntp-drift',
      findingId: 'f-1',
      humanAction: { action: 'close', target: 'f-1' },
      at: '2026-08-01T02:00:00.000Z',
    });

    expect(shadowAgreement(dir, 'auto-close-ntp-drift', sameAction).agreed).toBe(1);
  });
});

describe('@sangfor/scorecard — activation decision', () => {
  const base = { automationId: 'auto-close-ntp-drift', disagreements: [] as never[] };

  it('activates only when both the sample size and the agreement rate clear their bars', () => {
    expect(
      activationDecision({ ...base, compared: 50, agreed: 49, agreementRate: 0.98 }, { minCompared: 30, minRate: 0.95 }),
    ).toBe('activate');
  });

  it('keeps a small sample in shadow even at a perfect rate — small-n never activates', () => {
    expect(
      activationDecision({ ...base, compared: 3, agreed: 3, agreementRate: 1 }, { minCompared: 30, minRate: 0.95 }),
    ).toBe('keep-shadow');
    expect(
      activationDecision({ ...base, compared: 29, agreed: 29, agreementRate: 1 }, { minCompared: 30, minRate: 0.95 }),
    ).toBe('keep-shadow');
    expect(
      activationDecision({ ...base, compared: 0, agreed: 0, agreementRate: 0 }, { minCompared: 1, minRate: 0 }),
    ).toBe('keep-shadow');
  });

  it('keeps a large but disagreeing sample in shadow', () => {
    expect(
      activationDecision({ ...base, compared: 200, agreed: 100, agreementRate: 0.5 }, { minCompared: 30, minRate: 0.95 }),
    ).toBe('keep-shadow');
  });

  it('treats the thresholds as inclusive boundaries', () => {
    expect(
      activationDecision({ ...base, compared: 30, agreed: 29, agreementRate: 0.95 }, { minCompared: 30, minRate: 0.95 }),
    ).toBe('activate');
  });
});
