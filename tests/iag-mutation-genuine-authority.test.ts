import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isIagMutationActionAuthority,
  type IagMutationActionAuthority,
} from '../packages/sangfor-competency/src/index.js';
import { parseIagMutationAction } from '../packages/sangfor-product-adapters/src/apply/index.js';
import { digestCanonicalOrigin } from '../packages/shared/src/index.js';
import {
  cleanupTestIagMutationAuthorityEnvironment,
  resolveTestIagMutationAuthority,
  urlActionInput,
} from './helpers/iag-mutation-contract-fixture.js';

let root = '';
let authority: IagMutationActionAuthority;

function actionForAuthority() {
  return urlActionInput('ABSENT', authority);
}

function parseWith(candidate: unknown, input: unknown = actionForAuthority()) {
  return parseIagMutationAction({ source: JSON.stringify(input), authority: candidate });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'iag-contract-authority-'));
  authority = await resolveTestIagMutationAuthority(root);
});

afterAll(() => {
  cleanupTestIagMutationAuthorityEnvironment();
  rmSync(root, { recursive: true, force: true });
});

describe('genuine Todo 11 IAG mutation authority', () => {
  it('Given genuine internal authority resolution, When exact action is parsed, Then grounding succeeds', () => {
    expect(parseWith(authority)).toMatchObject({ ok: true });
    expect(isIagMutationActionAuthority(authority)).toBe(true);
    expect(Object.isFrozen(authority)).toBe(true);
    expect(Object.isFrozen(authority.firmwareTruth)).toBe(true);
    expect(Object.isFrozen(authority.allowedIntents.urlDomains)).toBe(true);
  });

  it.each([
    ['plain', () => ({
      product: authority.product, capabilityId: authority.capabilityId, toolId: authority.toolId,
      deviceIdentityDigest: authority.deviceIdentityDigest, origin: authority.origin,
      originDigest: authority.originDigest, campaignId: authority.campaignId,
      sessionId: authority.sessionId, windowId: authority.windowId,
      firmwareTruth: authority.firmwareTruth, implementation: authority.implementation,
      allowedIntents: authority.allowedIntents, now: authority.now,
      firmwareFreshness: authority.firmwareFreshness,
    })],
    ['spread', () => ({ ...authority })],
    ['prototype', () => Object.create(authority)],
    ['copied-symbol/descriptors', () => Object.defineProperties({}, Object.getOwnPropertyDescriptors(authority))],
  ])('Given a %s authority lookalike, When exact action is parsed, Then identity authentication refuses it', (_case, fabricate) => {
    const fake = fabricate();

    expect(isIagMutationActionAuthority(fake)).toBe(false);
    expect(parseWith(fake).ok).toBe(false);
  });

  it('Given genuine authority for one device, When device digest is changed, Then no grounded action is created', () => {
    const input = actionForAuthority();

    expect(parseWith(authority, {
      ...input,
      target: { ...input.target, deviceIdentityDigest: '9'.repeat(64) },
    }).ok).toBe(false);
  });

  it('Given genuine authority for one origin, When origin and digest are changed together, Then no grounded action is created', () => {
    const input = actionForAuthority();
    const origin = 'https://other.example.invalid';

    expect(parseWith(authority, {
      ...input,
      target: { ...input.target, origin, originDigest: digestCanonicalOrigin(origin, 'origin') },
    }).ok).toBe(false);
  });

  it('Given package dependency manifests, When inspected, Then competency remains below product-adapters with no reverse import', () => {
    const productManifest = JSON.parse(readFileSync(new URL('../packages/sangfor-product-adapters/package.json', import.meta.url), 'utf8'));
    const competencySource = readFileSync(new URL('../packages/sangfor-competency/src/index.ts', import.meta.url), 'utf8');

    expect(productManifest.dependencies['@sangfor/competency']).toBe('workspace:*');
    expect(competencySource).not.toContain('sangfor-product-adapters');
  });
});
