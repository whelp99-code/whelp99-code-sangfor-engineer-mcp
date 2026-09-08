import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IagMutationActionAuthority } from '../packages/sangfor-competency/src/index.js';
import {
  digestIagMutationAction,
  digestIagReadBackProof,
  parseIagMutationAction,
  parseIagMutationResult,
  parseIagReadBackProof,
  verifyIagMutationResult,
} from '../packages/sangfor-product-adapters/src/apply/index.js';
import {
  cleanupTestIagMutationAuthorityEnvironment,
  groundAction as parseGroundAction,
  groundProof,
  indeterminateProofInput,
  matchedProofInput,
  mismatchProofInput,
  resolveTestIagMutationAuthority,
  successResultInput,
  urlActionInput,
} from './helpers/iag-mutation-contract-fixture.js';

let root = '';
let authority: IagMutationActionAuthority;

function parseResult(source: unknown, action: unknown, readBackProof?: unknown) {
  return parseIagMutationResult({ source: JSON.stringify(source), action, readBackProof });
}

function groundAction(input: unknown = urlActionInput('ABSENT', authority)) {
  return parseGroundAction(input, authority);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'iag-result-contract-'));
  authority = await resolveTestIagMutationAuthority(root);
});

afterAll(() => {
  cleanupTestIagMutationAuthorityEnvironment();
  rmSync(root, { recursive: true, force: true });
});

describe('grounded IAG mutation result authority', () => {
  it('Given a grounded live action and independent exact proof, When SUCCEEDED is parsed and verified, Then success is authoritative', () => {
    const action = groundAction();
    const proof = groundProof(matchedProofInput(action), action);
    const parsed = parseResult(successResultInput(action, proof), action, proof);

    expect(parsed).toMatchObject({ ok: true, value: { outcome: 'SUCCEEDED', verifiedSuccess: true } });
    if (!parsed.ok) return;
    expect(verifyIagMutationResult({ result: parsed.value, action, readBackProof: proof })).toMatchObject({ ok: true });
  });

  it('Given exact desired state already observed before action, When NO_CHANGE_REQUIRED is grounded, Then no mutation is verified', () => {
    const action = groundAction(urlActionInput('EXACT_MATCH', authority));
    const proof = groundProof(matchedProofInput(action), action);
    const source = {
      ...successResultInput(action, proof), outcome: 'NO_CHANGE_REQUIRED',
      mutation: { attempted: false, count: 0 },
    };

    expect(parseResult(source, action, proof)).toMatchObject({
      ok: true, value: { outcome: 'NO_CHANGE_REQUIRED', verifiedSuccess: true },
    });
  });

  it('Given a detached caller action and self-consistent result JSON, When parsed, Then it cannot mint verified success', () => {
    const grounded = groundAction();
    const proof = groundProof(matchedProofInput(grounded), grounded);

    expect(parseResult(successResultInput(grounded, proof), urlActionInput('ABSENT', authority), proof).ok).toBe(false);
  });

  it('Given an arbitrary action digest, When result authority recomputes it, Then success is refused', () => {
    const action = groundAction();
    const proof = groundProof(matchedProofInput(action), action);

    expect(parseResult({ ...successResultInput(action, proof), actionDigest: '6'.repeat(64) }, action, proof).ok).toBe(false);
  });

  it('Given an arbitrary observed-state digest, When proof authority recomputes it, Then proof is refused', () => {
    const action = groundAction();

    expect(parseIagReadBackProof({
      source: JSON.stringify({ ...matchedProofInput(action), observedStateDigest: '7'.repeat(64) }),
      action,
    }).ok).toBe(false);
  });

  it('Given genuine authority for one device, When a generic proof chain retargets the action, Then no second action grounds', () => {
    const first = groundAction();
    const secondResult = parseIagMutationAction({
      source: JSON.stringify({
        ...first,
        target: { ...first.target, deviceIdentityDigest: '9'.repeat(64) },
      }),
      authority,
    });

    expect(secondResult.ok).toBe(false);
  });

  it.each([
    ['plan', (action: ReturnType<typeof urlActionInput>) => ({ ...action, bindings: { ...action.bindings, planId: 'plan-other' } })],
    ['task', (action: ReturnType<typeof urlActionInput>) => ({ ...action, bindings: { ...action.bindings, taskId: 'task-other' } })],
    ['campaign', (action: ReturnType<typeof urlActionInput>) => ({ ...action, bindings: { ...action.bindings, campaignId: 'campaign-other' } })],
    ['idempotency', (action: ReturnType<typeof urlActionInput>) => ({ ...action, bindings: { ...action.bindings, idempotencyKey: 'idem-other' } })],
    ['device', (action: ReturnType<typeof urlActionInput>) => ({ ...action, target: { ...action.target, deviceIdentityDigest: '9'.repeat(64) } })],
    ['origin', (action: ReturnType<typeof urlActionInput>) => ({ ...action, target: { ...action.target, origin: 'https://other.invalid' } })],
    ['session', (action: ReturnType<typeof urlActionInput>) => ({ ...action, target: { ...action.target, sessionId: 'session-other' } })],
    ['window', (action: ReturnType<typeof urlActionInput>) => ({ ...action, target: { ...action.target, windowId: 'window-other' } })],
    ['firmware', (action: ReturnType<typeof urlActionInput>) => ({ ...action, firmwareTruth: { ...action.firmwareTruth, truthDigest: '9'.repeat(64) } })],
    ['recipe', (action: ReturnType<typeof urlActionInput>) => ({ ...action, implementation: { ...action.implementation, recipeDigest: '9'.repeat(64) } })],
    ['tool', (action: ReturnType<typeof urlActionInput>) => ({ ...action, implementation: { ...action.implementation, toolDigest: '9'.repeat(64) } })],
    ['runtime', (action: ReturnType<typeof urlActionInput>) => ({ ...action, implementation: { ...action.implementation, runtimeDigest: '9'.repeat(64) } })],
    ['pre-state', (action: ReturnType<typeof urlActionInput>) => ({ ...action, preState: { ...action.preState, observed: action.readBackExpectation.expected } })],
    ['expected read-back', (action: ReturnType<typeof urlActionInput>) => ({ ...action, readBackExpectation: { ...action.readBackExpectation, verifierSessionId: 'verifier-session-other' } })],
  ])('Given result JSON rebound at %s scope, When checked against its grounded action, Then it is refused', (_case, mutate) => {
    const action = groundAction();
    const proof = groundProof(matchedProofInput(action), action);
    const result = successResultInput(action, proof);

    expect(parseResult({ ...result, action: mutate(urlActionInput('ABSENT', authority)) }, action, proof).ok).toBe(false);
  });

  it.each([
    ['DRY_RUN_COMPLETE', { finalReadBack: 'MATCHED', readBackProofDigest: '8'.repeat(64) }],
    ['REFUSED', { finalReadBack: 'MATCHED', readBackProofDigest: '8'.repeat(64) }],
  ])('Given %s carrying final matched read-back, When parsed, Then strict terminal shape refuses it', (outcome, contradiction) => {
    const input = { ...urlActionInput('ABSENT', authority), dryRun: outcome === 'DRY_RUN_COMPLETE' };
    const action = groundAction(input);

    expect(parseResult({
      schemaVersion: 'iag-internet-policy-result.v1', outcome, action,
      actionDigest: digestIagMutationAction(action), promotionEligible: false,
      mutation: { attempted: false, count: 0 }, verifiedSuccess: false,
      ...contradiction,
    }, action).ok).toBe(false);
  });

  it('Given FAILED_HALT with matched rather than mismatch proof, When parsed, Then contradiction is refused', () => {
    const action = groundAction();
    const proof = groundProof(matchedProofInput(action), action);

    expect(parseResult({
      ...successResultInput(action, proof), outcome: 'FAILED_HALT', verifiedSuccess: false,
    }, action, proof).ok).toBe(false);
  });

  it('Given INDETERMINATE with matched proof, When parsed, Then contradiction is refused', () => {
    const action = groundAction();
    const proof = groundProof(matchedProofInput(action), action);

    expect(parseResult({
      ...successResultInput(action, proof), outcome: 'INDETERMINATE', verifiedSuccess: false,
    }, action, proof).ok).toBe(false);
  });

  it('Given FAILED_HALT with definite mismatch proof, When parsed, Then failure remains unverified', () => {
    const action = groundAction();
    const proof = groundProof(mismatchProofInput(action), action);

    expect(parseResult({
      ...successResultInput(action, proof), outcome: 'FAILED_HALT',
      readBackProofDigest: digestIagReadBackProof(proof), verifiedSuccess: false,
      finalReadBack: 'MISMATCHED', reasonCode: 'MUTATION_FAILED',
    }, action, proof)).toMatchObject({ ok: true, value: { verifiedSuccess: false } });
  });

  it('Given unknown independent read-back, When INDETERMINATE is parsed, Then it never claims success', () => {
    const action = groundAction();
    const proof = groundProof(indeterminateProofInput(action), action);

    expect(parseResult({
      ...successResultInput(action, proof), outcome: 'INDETERMINATE',
      readBackProofDigest: digestIagReadBackProof(proof), verifiedSuccess: false,
      finalReadBack: 'INDETERMINATE', reasonCode: 'READ_BACK_UNKNOWN',
    }, action, proof)).toMatchObject({ ok: true, value: { verifiedSuccess: false } });
  });

  it('Given read-back is unavailable, When INDETERMINATE is parsed without generic evidence, Then it remains unverified', () => {
    const action = groundAction();
    const source = {
      schemaVersion: 'iag-internet-policy-result.v1', outcome: 'INDETERMINATE', action,
      actionDigest: digestIagMutationAction(action), promotionEligible: false,
      mutation: { attempted: true, count: 1 }, verifiedSuccess: false,
      finalReadBack: 'UNAVAILABLE', readBackProofDigest: null, reasonCode: 'READ_BACK_UNAVAILABLE',
    };

    expect(parseResult(source, action)).toMatchObject({
      ok: true, value: { outcome: 'INDETERMINATE', verifiedSuccess: false },
    });
  });

  it('Given absent observed pre-state, When NO_CHANGE_REQUIRED is claimed, Then semantic authority refuses it', () => {
    const action = groundAction();
    const proof = groundProof(matchedProofInput(action), action);

    expect(parseResult({
      ...successResultInput(action, proof), outcome: 'NO_CHANGE_REQUIRED',
      mutation: { attempted: false, count: 0 },
    }, action, proof).ok).toBe(false);
  });

  it('Given exact-match observed pre-state, When SUCCEEDED claims one mutation, Then unnecessary mutation is refused', () => {
    const action = groundAction(urlActionInput('EXACT_MATCH', authority));
    const proof = groundProof(matchedProofInput(action), action);

    expect(parseResult(successResultInput(action, proof), action, proof).ok).toBe(false);
  });

  it('Given a structurally forged result object, When public verify is called directly, Then no authority is inferred', () => {
    expect(verifyIagMutationResult({ result: {}, action: groundAction() }).ok).toBe(false);
  });
});
