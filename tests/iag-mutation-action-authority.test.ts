import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IagMutationActionAuthority } from '../packages/sangfor-competency/src/index.js';
import {
  digestIagMutationAction,
  parseIagMutationAction,
} from '../packages/sangfor-product-adapters/src/apply/index.js';
import { digestCanonicalOrigin } from '../packages/shared/src/index.js';
import {
  applicationActionInput,
  cleanupTestIagMutationAuthorityEnvironment,
  groundAction,
  resolveTestIagMutationAuthority,
  urlActionInput,
} from './helpers/iag-mutation-contract-fixture.js';

let root = '';
let authority: IagMutationActionAuthority;

function parse(input: unknown, candidate: unknown = authority) {
  return parseIagMutationAction({ source: JSON.stringify(input), authority: candidate });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'iag-action-contract-'));
  authority = await resolveTestIagMutationAuthority(root);
});

afterAll(() => {
  cleanupTestIagMutationAuthorityEnvironment();
  rmSync(root, { recursive: true, force: true });
});

describe('authenticated IAG mutation action authority', () => {
  it('Given genuine campaign authority and fresh firmware, When parsed, Then a deeply frozen grounded action is returned', () => {
    const parsed = parse(urlActionInput('ABSENT', authority));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.preState.mode).toBe('absent_or_exact_match');
    expect(Object.isFrozen(parsed.value)).toBe(true);
    expect(Object.isFrozen(parsed.value.bindings)).toBe(true);
    expect(Object.isFrozen(parsed.value.target)).toBe(true);
    expect(Object.isFrozen(parsed.value.firmwareTruth)).toBe(true);
    expect(Object.isFrozen(parsed.value.readBackExpectation.expected)).toBe(true);
    expect(digestIagMutationAction(parsed.value)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each([
    ['absent URL', () => urlActionInput('ABSENT', authority)],
    ['exact-match URL', () => urlActionInput('EXACT_MATCH', authority)],
    ['absent application', () => applicationActionInput(authority)],
  ])('Given %s idempotent pre-state, When parsed, Then the single desired exception is grounded', (_case, input) => {
    expect(parse(input()).ok).toBe(true);
  });

  it('Given a structurally valid value outside campaign authority, When parsed, Then it is refused', () => {
    const input = urlActionInput('ABSENT', authority);

    expect(parse({ ...input, intent: { ...input.intent, value: 'other.example.invalid' } }).ok).toBe(false);
  });

  it.each(['com', 'co.uk', 'github.io', '127.0.0.1', '*.example.invalid', 'example.invalid.', 'example.invalid/path'])(
    'Given genuine authority listing invalid exception %s, When parsed, Then PSL-aware structure still refuses it',
    (value) => {
      const input = urlActionInput('ABSENT', authority);
      const changed = {
        ...input,
        preState: { mode: 'absent_or_exact_match', observed: { kind: 'URL_DOMAIN_EXCEPTION_ABSENT', value } },
        intent: { kind: 'URL_DOMAIN_EXCEPTION', value, effect: 'ALLOW' },
        readBackExpectation: {
          ...input.readBackExpectation,
          expected: { kind: 'URL_DOMAIN_EXCEPTION_PRESENT', value, effect: 'ALLOW' },
        },
      };

      expect(parse(changed).ok).toBe(false);
    },
  );

  it.each(['example.com', 'www.example.com', 'qa.example.invalid'])(
    'Given genuinely allowed registrable or reserved lab domain %s, When parsed, Then it is accepted',
    (value) => {
      const input = urlActionInput('ABSENT', authority);
      const changed = {
        ...input,
        preState: { mode: 'absent_or_exact_match', observed: { kind: 'URL_DOMAIN_EXCEPTION_ABSENT', value } },
        intent: { kind: 'URL_DOMAIN_EXCEPTION', value, effect: 'ALLOW' },
        readBackExpectation: {
          ...input.readBackExpectation,
          expected: { kind: 'URL_DOMAIN_EXCEPTION_PRESENT', value, effect: 'ALLOW' },
        },
      };

      expect(parse(changed).ok).toBe(true);
    },
  );

  it('Given an application ID outside genuine campaign authority, When parsed, Then it is refused', () => {
    const input = applicationActionInput(authority);
    const applicationId = 'app.other';

    expect(parse({
      ...input,
      preState: { mode: 'absent_or_exact_match', observed: { kind: 'APPLICATION_EXCEPTION_ABSENT', applicationId } },
      intent: { kind: 'APPLICATION_EXCEPTION', applicationId, effect: 'ALLOW' },
      readBackExpectation: {
        ...input.readBackExpectation,
        expected: { kind: 'APPLICATION_EXCEPTION_PRESENT', applicationId, effect: 'ALLOW' },
      },
    }).ok).toBe(false);
  });

  it.each([
    'https://*.example.invalid', 'https://example.invalid.', 'https://user@example.invalid',
    'https://example.invalid/path', 'https://example.invalid?query=1', 'https://example.invalid#fragment',
  ])('Given unsafe origin %s with its recomputed digest, When parsed, Then it is refused', (origin) => {
    const input = urlActionInput('ABSENT', authority);
    const originDigest = origin.includes('*') || origin.endsWith('.')
      ? digestCanonicalOrigin(origin, 'origin')
      : input.target.originDigest;

    expect(parse({ ...input, target: { ...input.target, origin, originDigest } }).ok).toBe(false);
  });

  it.each([
    ['stale', '2026-08-20T08:59:59.999Z'],
    ['future', '2026-08-20T11:00:30.001Z'],
  ])('Given %s firmware observation, When parsed against authenticated now, Then it is refused', (_case, observedAt) => {
    const input = urlActionInput('ABSENT', authority);

    expect(parse({ ...input, firmwareTruth: { ...input.firmwareTruth, observedAt } }).ok).toBe(false);
  });

  it('Given campaign identity different from genuine authority, When parsed, Then it is refused', () => {
    const input = urlActionInput('ABSENT', authority);
    expect(parse({ ...input, bindings: { ...input.bindings, campaignId: 'campaign-other' } }).ok).toBe(false);
  });

  it('Given colliding role IDs, When parsed, Then identity roles cannot collapse', () => {
    const input = urlActionInput('ABSENT', authority);
    const collision = 'same-id';

    expect(parse({
      ...input,
      bindings: { planId: collision, taskId: collision, campaignId: collision, idempotencyKey: collision },
      target: { ...input.target, sessionId: collision, windowId: collision },
      firmwareTruth: { ...input.firmwareTruth, recordId: collision },
      readBackExpectation: { ...input.readBackExpectation, verifierSessionId: collision },
    }).ok).toBe(false);
  });

  it('Given swapped role namespaces, When parsed, Then semantically distinct IDs are refused', () => {
    const input = urlActionInput('ABSENT', authority);
    expect(parse({ ...input, bindings: { ...input.bindings, planId: 'task-o1-13', taskId: 'plan-o1-13' } }).ok).toBe(false);
  });

  it('Given a detached raw action lookalike, When a digest is requested, Then it has no grounded authority', () => {
    expect(() => digestIagMutationAction(urlActionInput('ABSENT', authority))).toThrow();
    expect(() => groundAction(urlActionInput('ABSENT', authority), authority)).not.toThrow();
  });
});
