import { describe, expect, it } from 'vitest';
import {
  advanceFinding,
  type AdvanceFindingInput,
  type FindingState,
} from '../packages/sangfor-first-line/src/index.js';

/**
 * Design 002, blocks E1 and E2 — the non-mutating first-line ladder.
 *
 * detected -> corroborated -> enriched -> (auto-resolved-observed | escalated).
 * Every transition is a pure function returning the next state plus a ledger
 * entry the caller persists; the machine itself writes nothing, holds no
 * approval, and can never authorise a device write.
 */

const base = {
  findingKey: 'ntp-drift/dev-1',
  deviceId: 'dev-1',
  at: '2026-08-03T09:00:00.000Z',
} as const;

function state(current: FindingState): AdvanceFindingInput['finding'] {
  return { findingKey: base.findingKey, deviceId: base.deviceId, state: current };
}

describe('@sangfor/first-line — escalation ladder (E1)', () => {
  it('walks detected -> corroborated -> enriched -> escalated, ledgering each step', () => {
    const corroborated = advanceFinding({
      finding: state('detected'),
      event: { type: 'corroborate', corroboratingSource: 'browser-cdp-recollect' },
      at: base.at,
    });
    expect(corroborated.next.state).toBe('corroborated');
    expect(corroborated.ledgerEntry).toEqual({
      findingKey: base.findingKey,
      deviceId: base.deviceId,
      from: 'detected',
      to: 'corroborated',
      at: base.at,
      reason: 'corroborated-by-second-source',
    });

    const enriched = advanceFinding({
      finding: corroborated.next,
      event: { type: 'enrich', dossierRef: 'dossier-1' },
      at: '2026-08-03T09:05:00.000Z',
    });
    expect(enriched.next.state).toBe('enriched');
    expect(enriched.ledgerEntry.reason).toBe('dossier-assembled');

    const escalated = advanceFinding({
      finding: enriched.next,
      event: { type: 'escalate', escalationTarget: 'tier-2' },
      at: '2026-08-03T09:10:00.000Z',
    });
    expect(escalated.next.state).toBe('escalated');
    expect(escalated.ledgerEntry).toMatchObject({
      from: 'enriched',
      to: 'escalated',
      reason: 'escalated-to-human',
    });
  });

  it('is pure — the input finding is never mutated', () => {
    const finding = state('detected');
    const snapshot = JSON.parse(JSON.stringify(finding)) as unknown;

    advanceFinding({
      finding,
      event: { type: 'corroborate', corroboratingSource: 'api-recollect' },
      at: base.at,
    });

    expect(finding).toEqual(snapshot);
  });

  it('throws on an illegal transition instead of coercing the state', () => {
    expect(() =>
      advanceFinding({
        finding: state('detected'),
        event: { type: 'enrich', dossierRef: 'dossier-1' },
        at: base.at,
      }),
    ).toThrow(/detected/u);

    expect(() =>
      advanceFinding({
        finding: state('escalated'),
        event: { type: 'corroborate', corroboratingSource: 'api-recollect' },
        at: base.at,
      }),
    ).toThrow(/escalated/u);
  });

  it('auto-resolves only from enriched and only with observed clearing evidence', () => {
    const enriched = state('enriched');

    const resolved = advanceFinding({
      finding: enriched,
      event: {
        type: 'auto-resolve',
        clearingEvidence: {
          observedAt: '2026-08-03T09:20:00.000Z',
          source: 'api-recollect',
          detail: 'ntp offset back inside envelope',
        },
      },
      at: '2026-08-03T09:21:00.000Z',
    });

    expect(resolved.next.state).toBe('auto-resolved-observed');
    expect(resolved.ledgerEntry).toMatchObject({
      to: 'auto-resolved-observed',
      reason: 'clearing-evidence-observed',
    });

    expect(() =>
      advanceFinding({
        finding: state('corroborated'),
        event: {
          type: 'auto-resolve',
          clearingEvidence: { observedAt: '2026-08-03T09:20:00.000Z', source: 'api-recollect' },
        },
        at: base.at,
      }),
    ).toThrow(/corroborated/u);
  });

  it('escalates from corroborated as well as enriched (a dossier is not required to hand off)', () => {
    const escalated = advanceFinding({
      finding: state('corroborated'),
      event: { type: 'escalate', escalationTarget: 'tier-2' },
      at: base.at,
    });

    expect(escalated.next.state).toBe('escalated');
  });

  it('records the clearing evidence on the resolved finding so the ladder stays auditable', () => {
    const resolved = advanceFinding({
      finding: state('enriched'),
      event: {
        type: 'auto-resolve',
        clearingEvidence: { observedAt: '2026-08-03T09:20:00.000Z', source: 'browser-cdp-recollect' },
      },
      at: '2026-08-03T09:21:00.000Z',
    });

    expect(resolved.next.clearingEvidence).toEqual({
      observedAt: '2026-08-03T09:20:00.000Z',
      source: 'browser-cdp-recollect',
    });
  });
});

describe('@sangfor/first-line — flap promotion (E2)', () => {
  const flapEvent = (history: readonly string[]) =>
    ({
      type: 'auto-resolve',
      clearingEvidence: { observedAt: '2026-08-03T09:20:00.000Z', source: 'api-recollect' },
      flapPolicy: { maxAutoResolves: 3, windowMs: 24 * 60 * 60 * 1000 },
      priorAutoResolvedAt: history,
    }) as const;

  it('forces escalation on the Nth auto-resolve of the same finding inside the window', () => {
    const result = advanceFinding({
      finding: state('enriched'),
      event: flapEvent(['2026-08-03T01:00:00.000Z', '2026-08-03T05:00:00.000Z']),
      at: '2026-08-03T09:21:00.000Z',
    });

    expect(result.next.state).toBe('escalated');
    expect(result.ledgerEntry).toMatchObject({
      from: 'enriched',
      to: 'escalated',
      reason: 'flapping',
    });
  });

  it('still auto-resolves below the flap threshold', () => {
    const result = advanceFinding({
      finding: state('enriched'),
      event: flapEvent(['2026-08-03T05:00:00.000Z']),
      at: '2026-08-03T09:21:00.000Z',
    });

    expect(result.next.state).toBe('auto-resolved-observed');
  });

  it('ignores prior auto-resolves that fall outside the injected window', () => {
    const result = advanceFinding({
      finding: state('enriched'),
      event: flapEvent(['2026-07-01T01:00:00.000Z', '2026-07-02T05:00:00.000Z']),
      at: '2026-08-03T09:21:00.000Z',
    });

    expect(result.next.state).toBe('auto-resolved-observed');
  });

  it('counts the window boundary as inside the window', () => {
    const result = advanceFinding({
      finding: state('enriched'),
      event: flapEvent(['2026-08-02T09:21:00.000Z', '2026-08-03T05:00:00.000Z']),
      at: '2026-08-03T09:21:00.000Z',
    });

    expect(result.next.state).toBe('escalated');
    expect(result.ledgerEntry.reason).toBe('flapping');
  });
});

describe('@sangfor/first-line — the ladder is structurally non-mutating (E1)', () => {
  it('exposes no approval-shaped field on any finding, event, or ledger entry it produces', () => {
    const chain = [
      advanceFinding({
        finding: state('detected'),
        event: { type: 'corroborate', corroboratingSource: 'api-recollect' },
        at: base.at,
      }),
      advanceFinding({
        finding: state('enriched'),
        event: { type: 'escalate', escalationTarget: 'tier-2' },
        at: base.at,
      }),
      advanceFinding({
        finding: state('enriched'),
        event: {
          type: 'auto-resolve',
          clearingEvidence: { observedAt: base.at, source: 'api-recollect' },
        },
        at: base.at,
      }),
    ];

    const forbidden = /approval|approve|nonce|signature|hmac|apply|mutat|writeback|command/iu;
    for (const { next, ledgerEntry } of chain) {
      for (const key of Object.keys(next)) expect(key).not.toMatch(forbidden);
      for (const key of Object.keys(ledgerEntry)) expect(key).not.toMatch(forbidden);
    }
  });

  it('rejects an unknown event type rather than passing it through', () => {
    expect(() =>
      advanceFinding({
        finding: state('detected'),
        // A caller reaching for a device write must not find a door here.
        event: { type: 'apply-fix' } as unknown as AdvanceFindingInput['event'],
        at: base.at,
      }),
    ).toThrow(/apply-fix/u);
  });
});
