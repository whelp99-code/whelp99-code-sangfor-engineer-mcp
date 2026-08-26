import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IagMutationActionAuthority } from '../packages/sangfor-competency/src/index.js';
import {
  cleanupTestIagMutationAuthorityEnvironment,
  resolveTestIagMutationAuthority,
} from './helpers/iag-mutation-contract-fixture.js';
import {
  executorActionFor,
  replayFixture,
} from './helpers/iag-executor-runtime-fixture.js';

let root = '';
let authority: IagMutationActionAuthority;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'iag-executor-idempotency-'));
  authority = await resolveTestIagMutationAuthority(root);
});
afterAll(() => {
  cleanupTestIagMutationAuthorityEnvironment();
  rmSync(root, { recursive: true, force: true });
});

describe('IAG executor idempotency binding', () => {
  it('Given exact same-key replay, When preflight succeeds again, Then it returns typed already-dispatched data without side effects', async () => {
    const action = executorActionFor('qa.example.invalid', authority);
    const fixture = replayFixture([action, action]);

    const first = await fixture.executor.execute(action);
    const replay = await fixture.executor.execute(action);

    expect(first.mutationAttempted).toBe(true);
    expect(replay.dispatch).toMatchObject({
      status: 'ALREADY_DISPATCHED', code: 'already_dispatched', firstActionDigest: first.actionDigest,
    });
    expect(replay.mutationAttempted).toBe(false);
    expect(fixture.preflights).toHaveLength(1);
    expect(fixture.dispatches).toHaveLength(1);
    expect(fixture.readBacks).toHaveLength(1);
  });

  it('Given same key with a different grounded digest, When reused, Then typed idempotency conflict has no dispatch or read-back', async () => {
    const firstAction = executorActionFor('qa.example.invalid', authority);
    const conflictingAction = executorActionFor('example.com', authority);
    const fixture = replayFixture([firstAction, conflictingAction]);

    const first = await fixture.executor.execute(firstAction);
    const conflict = await fixture.executor.execute(conflictingAction);

    expect(conflict.dispatch).toMatchObject({
      status: 'IDEMPOTENCY_CONFLICT', code: 'idempotency_conflict', firstActionDigest: first.actionDigest,
      conflictingActionDigest: conflict.actionDigest,
    });
    expect(conflict.mutationAttempted).toBe(false);
    expect(fixture.preflights).toHaveLength(1);
    expect(fixture.dispatches).toHaveLength(1);
    expect(fixture.readBacks).toHaveLength(1);
  });

  it('Given dispatch throws after invocation, When the exact action is retried, Then its key remains bound and no retry dispatch occurs', async () => {
    const action = executorActionFor('qa.example.invalid', authority);
    const fixture = replayFixture([action, action], 'throw');

    const first = await fixture.executor.execute(action);
    const replay = await fixture.executor.execute(action);

    expect(first.dispatch).toMatchObject({ status: 'UNKNOWN', error: { code: 'DISPATCH_ERROR' } });
    expect(replay.dispatch?.status).toBe('ALREADY_DISPATCHED');
    expect(fixture.preflights).toHaveLength(1);
    expect(fixture.dispatches).toHaveLength(1);
    expect(fixture.readBacks).toHaveLength(1);
  });

  it('Given concurrent different actions sharing one key, When both preflights pass, Then one key binds and at most one dispatches', async () => {
    const firstAction = executorActionFor('qa.example.invalid', authority);
    const conflictingAction = executorActionFor('example.com', authority);
    const fixture = replayFixture([firstAction, conflictingAction]);

    const outputs = await Promise.all([
      fixture.executor.execute(firstAction), fixture.executor.execute(conflictingAction),
    ]);

    expect(fixture.dispatches).toHaveLength(1);
    expect(outputs.filter(({ mutationAttempted }) => mutationAttempted)).toHaveLength(1);
    expect(outputs.some(({ dispatch }) => dispatch?.status === 'IDEMPOTENCY_CONFLICT')).toBe(true);
  });
});
