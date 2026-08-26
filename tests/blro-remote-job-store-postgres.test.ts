import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExactSignal } from './helpers/exact-signal.js';
import {
  RemoteJobAuthorityFixture,
  type TaskScopeName,
} from './helpers/remote-job-authority-fixture.js';
import { ProbedRemoteJobDatabase } from './helpers/remote-job-database-probe.js';
import { scopedOwnerQuery } from './helpers/scoped-owner-database.js';
import {
  parseTaskResult as parsedResult,
  taskPassResult as passResult,
} from './helpers/remote-job-result-fixture.js';

const databaseUrl = process.env.DATABASE_URL ?? '';
const ownerUrl = process.env.BLRO_OWNER_DATABASE_URL ?? '';
const runPostgres = Boolean(databaseUrl && ownerUrl);
let fixture: RemoteJobAuthorityFixture;

function leafCertificate() {
  return { encoding: 'der-base64' as const, value: fixture.certificates.validDerBase64 };
}

async function remoteJobCount(scope: TaskScopeName = 'primary'): Promise<number> {
  const projectId = fixture.scope(scope).projectId;
  const rows = await scopedOwnerQuery<{ readonly count: number }>({
    owner: fixture.owner,
    projectId,
    query: `SELECT count(*)::int count FROM "BlroRemoteJob" WHERE "projectId"=$1`,
    values: [projectId],
  });
  return rows[0]?.count ?? 0;
}

describe.runIf(runPostgres)('Todo 22 PostgreSQL remote-job authority', () => {
  beforeAll(async () => {
    fixture = await RemoteJobAuthorityFixture.create(databaseUrl, ownerUrl);
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());

  it('atomically commits JTI plus tombstone before one dispatch, then retains exactly by digest', async () => {
    // Given a valid enrolled request whose executor is held at its exact entry event.
    const probe = new ProbedRemoteJobDatabase(fixture.databaseA);
    const executorEntered = new ExactSignal('executor entered');
    const releaseExecutor = new ExactSignal('executor released');
    const transactionStates: boolean[] = [];
    const request = fixture.request('atomic-request');
    const envelope = fixture.envelope({ request, jobId: 'atomic-job', jti: 'atomic-jti' });
    const execute = vi.fn(async () => {
      transactionStates.push(probe.isInTransaction());
      executorEntered.resolve();
      await releaseExecutor.promise;
      return passResult(request.requestId);
    });
    const handler = fixture.handler(fixture.store(probe), { execute });

    // When dispatch reaches the external executor.
    const pending = handler.handle(fixture.handlerInput(envelope));
    await executorEntered.promise;
    const rows = await scopedOwnerQuery<{
      readonly state: string; readonly jtis: number;
    }>({
      owner: fixture.owner,
      projectId: fixture.primaryProjectId,
      query: `SELECT j."state",count(c.*)::int jtis FROM "BlroRemoteJob" j
       JOIN "BlroRemoteJobCapabilityJti" c ON c."jti"=j."capabilityJti"
       WHERE j."jobId"=$1 GROUP BY j."state"`,
      values: ['atomic-job'],
    });
    releaseExecutor.resolve();
    const first = await pending;

    // Then authority is durable first, execution is outside SQL, and only fresh JTI duplicates read back.
    expect(rows).toEqual([{ state: 'dispatch_committed', jtis: 1 }]);
    expect(transactionStates).toEqual([false]);
    const exact = fixture.envelope({ request, jobId: 'atomic-job' });
    const retained = await handler.handle(fixture.handlerInput(exact));
    expect(parsedResult(retained.bodyText)).toEqual(parsedResult(first.bodyText));
    const lookups = probe.remoteJobLookups;
    expect((await handler.handle(fixture.handlerInput(envelope))).statusCode).toBe(403);
    const wrongJti = fixture.envelope({
      request: fixture.request('wrong-jti-request'), jobId: 'wrong-jti-job', jti: 'atomic-jti',
    });
    expect((await handler.handle(fixture.handlerInput(wrongJti))).statusCode).toBe(403);
    expect(probe.remoteJobLookups).toBe(lookups);
    const changed = fixture.envelope({ request: fixture.request('changed-request'), jobId: 'atomic-job' });
    expect((await handler.handle(fixture.handlerInput(changed))).statusCode).toBe(409);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('allows one dispatch across 32 concurrent duplicates and two store instances', async () => {
    // Given 32 fresh capabilities for one exact request across two Prisma-backed stores.
    const firstProbe = new ProbedRemoteJobDatabase(fixture.databaseA);
    const secondProbe = new ProbedRemoteJobDatabase(fixture.databaseB);
    const callsStarted = new ExactSignal('all duplicate calls started');
    const request = fixture.request('concurrent-request');
    const expected = passResult(request.requestId, 'concurrent');
    const execute = vi.fn(async () => {
      expect(firstProbe.isInTransaction() || secondProbe.isInTransaction()).toBe(false);
      await callsStarted.promise;
      return expected;
    });
    const handlers = [
      fixture.handler(fixture.store(firstProbe), { execute }),
      fixture.handler(fixture.store(secondProbe), { execute }),
    ] as const;

    // When all calls are started before the executor is released.
    const calls = Array.from({ length: 32 }, (_, index) => handlers[index % 2]?.handle(
      fixture.handlerInput(fixture.envelope({ request, jobId: 'concurrent-job' })),
    ));
    callsStarted.resolve();
    const responses = await Promise.all(calls);

    // Then one tombstone/JTI wins and restart reads the exact retained result without redispatch.
    expect(execute).toHaveBeenCalledOnce();
    expect(await remoteJobCount()).toBe(1);
    expect(responses.map(({ statusCode }) => statusCode)).toEqual(Array.from({ length: 32 }, () => 200));
    const restarted = fixture.handler(fixture.store(fixture.databaseB), { execute });
    const replay = await restarted.handle(fixture.handlerInput(
      fixture.envelope({ request, jobId: 'concurrent-job' }),
    ));
    expect(parsedResult(replay.bodyText)).toEqual(expected);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('isolates the same job ID across projects and refuses cross-scope before lookup', async () => {
    // Given two independently enrolled project authorities.
    const probe = new ProbedRemoteJobDatabase(fixture.databaseA);
    const request = fixture.request('cross-scope-request');
    const execute = vi.fn(async () => passResult(request.requestId));
    const primary = fixture.handler(fixture.store(probe), { execute });
    const foreign = fixture.handler(fixture.store(fixture.databaseB, 'foreign'), { execute });
    const primaryEnvelope = fixture.envelope({ request, jobId: 'shared-job' });
    const foreignEnvelope = fixture.envelope({ scope: 'foreign', request, jobId: 'shared-job' });

    // When each scope submits the same job ID and primary is offered the foreign envelope.
    await Promise.all([
      primary.handle(fixture.handlerInput(primaryEnvelope)),
      foreign.handle(fixture.handlerInput(foreignEnvelope)),
    ]);
    const lookups = probe.remoteJobLookups;
    const refused = await primary.handle(fixture.handlerInput(foreignEnvelope));

    // Then each scope has one authority row and cross-scope observes no retained state.
    expect(await remoteJobCount('primary')).toBe(1);
    expect(await remoteJobCount('foreign')).toBe(1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(refused.statusCode).toBe(403);
    expect(probe.remoteJobLookups).toBe(lookups);
  });

  it('permits retry after pre-commit failure and retries serialization or deadlock only before dispatch', async () => {
    // Given deterministic database failures before a tombstone can commit.
    const probe = new ProbedRemoteJobDatabase(fixture.databaseA);
    const request = fixture.request('retry-request');
    const execute = vi.fn(async () => passResult(request.requestId));
    const handler = fixture.handler(fixture.store(probe), { execute });
    const envelope = fixture.envelope({ request, jobId: 'retry-job', jti: 'retry-jti' });
    probe.failNextTransaction('08006');

    // When a caller retries the same proof, then serialization and deadlock retries occur internally.
    expect((await handler.handle(fixture.handlerInput(envelope))).statusCode).toBe(503);
    expect(await remoteJobCount()).toBe(0);
    await handler.handle(fixture.handlerInput(envelope));
    const retryRequest = fixture.request('transaction-retry-request');
    probe.failNextTransaction('40001');
    probe.failNextTransaction('40P01');
    await handler.handle(fixture.handlerInput(
      fixture.envelope({ request: retryRequest, jobId: 'transaction-retry-job' }),
    ));

    // Then each job dispatches once and no transaction retry calls the executor.
    expect(execute).toHaveBeenCalledTimes(2);
    expect(await remoteJobCount()).toBe(2);
  });

  it('keeps a tombstone-only restart sticky INDETERMINATE without dispatch', async () => {
    // Given a first authority transaction that commits but its process never calls the executor.
    const request = fixture.request('tombstone-request');
    const envelope = fixture.envelope({ request, jobId: 'tombstone-job' });
    const reserved = await fixture.store().authorizeAndReserve({
      envelope, certificate: leafCertificate(),
    });
    expect(reserved.kind).toBe('dispatch');
    const execute = vi.fn(async () => passResult(request.requestId));

    // When a restarted store receives fresh exact duplicates.
    const restarted = fixture.handler(fixture.store(fixture.databaseB), { execute });
    const responses = await Promise.all([1, 2].map(() => restarted.handle(fixture.handlerInput(
      fixture.envelope({ request, jobId: 'tombstone-job' }),
    ))));

    // Then every response preserves uncertainty and none redispatches.
    expect(responses.map(({ bodyText }) => parsedResult(bodyText).status))
      .toEqual(['INDETERMINATE', 'INDETERMINATE']);
    expect(execute).not.toHaveBeenCalled();
  });

});
