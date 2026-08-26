import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  browserExecutionResultSchema,
  type BrowserExecutionRequest,
  type JobEnvelope,
} from '../packages/sangfor-browser-contracts/src/index.js';
import { RemoteJobAuthorityFixture } from './helpers/remote-job-authority-fixture.js';
import { ProbedRemoteJobDatabase } from './helpers/remote-job-database-probe.js';
import {
  parseTaskResult,
  taskPassResult,
} from './helpers/remote-job-result-fixture.js';
import {
  scopedOwnerExecute,
  scopedOwnerQuery,
} from './helpers/scoped-owner-database.js';

const databaseUrl = process.env.DATABASE_URL ?? '';
const ownerUrl = process.env.BLRO_OWNER_DATABASE_URL ?? '';
const runPostgres = Boolean(databaseUrl && ownerUrl);
let fixture: RemoteJobAuthorityFixture;

describe.runIf(runPostgres)('Todo 22 PostgreSQL remote-job recovery', () => {
  beforeAll(async () => {
    fixture = await RemoteJobAuthorityFixture.create(databaseUrl, ownerUrl);
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());

  it('seals executor throw and detects a scoped forged retained result digest', async () => {
    // Given an executor failure after the dispatch tombstone.
    const thrownRequest = fixture.request('executor-throw-request');
    const throwing = vi.fn(async () => { throw new TypeError('executor fixture failed'); });
    const thrownHandler = fixture.handler(fixture.store(), { execute: throwing });

    // When the executor throws, then restart remains indeterminate without another execution.
    const thrown = await thrownHandler.handle(fixture.handlerInput(
      fixture.envelope({ request: thrownRequest, jobId: 'executor-throw-job' }),
    ));
    expect(parseTaskResult(thrown.bodyText).status).toBe('INDETERMINATE');
    const replacement = vi.fn(async () => taskPassResult(thrownRequest.requestId));
    const replay = await fixture.handler(fixture.store(fixture.databaseB), { execute: replacement })
      .handle(fixture.handlerInput(fixture.envelope({ request: thrownRequest, jobId: 'executor-throw-job' })));
    expect(parseTaskResult(replay.bodyText).status).toBe('INDETERMINATE');
    expect(replacement).not.toHaveBeenCalled();

    // Given a retained result whose scoped JSON is forged without its digest.
    const forgedRequest = fixture.request('forged-result-request');
    const success = vi.fn(async () => taskPassResult(forgedRequest.requestId));
    const forgedHandler = fixture.handler(fixture.store(), { execute: success });
    await forgedHandler.handle(fixture.handlerInput(
      fixture.envelope({ request: forgedRequest, jobId: 'forged-result-job' }),
    ));
    const forgedResult = taskPassResult('forged-request-id');
    const affected = await scopedOwnerExecute({
      owner: fixture.owner,
      projectId: fixture.primaryProjectId,
      query: `UPDATE "BlroRemoteJob" SET "result"=$1::jsonb WHERE "jobId"=$2`,
      values: [JSON.stringify(forgedResult), 'forged-result-job'],
    });
    expect(affected).toBe(1);
    const tampered = await scopedOwnerQuery<{ readonly result: unknown }>({
      owner: fixture.owner,
      projectId: fixture.primaryProjectId,
      query: `SELECT "result" FROM "BlroRemoteJob" WHERE "jobId"=$1`,
      values: ['forged-result-job'],
    });
    expect(browserExecutionResultSchema.parse(tampered[0]?.result)).toEqual(forgedResult);

    // When a fresh authorized duplicate reads the forged row, then no forged PASS is served.
    const forged = await forgedHandler.handle(fixture.handlerInput(
      fixture.envelope({ request: forgedRequest, jobId: 'forged-result-job' }),
    ));
    expect(parseTaskResult(forged.bodyText).status).toBe('INDETERMINATE');
    expect(success).toHaveBeenCalledOnce();
  });

  it('returns INDETERMINATE for unknown result-commit acknowledgement, then reads durable truth', async () => {
    // Given a database adapter that commits the result and loses only the acknowledgement.
    const probe = new ProbedRemoteJobDatabase(fixture.databaseA);
    probe.failAfterNextResultCommit();
    const request = fixture.request('unknown-commit-request');
    const expected = taskPassResult(request.requestId, 'unknown-commit');
    const execute = vi.fn(async () => expected);
    const handler = fixture.handler(fixture.store(probe), { execute });

    // When dispatch completes through the unknown commit outcome.
    const uncertain = await handler.handle(fixture.handlerInput(
      fixture.envelope({ request, jobId: 'unknown-commit-job' }),
    ));

    // Then this call stays indeterminate, while fresh authorization reads exact durable truth.
    expect(parseTaskResult(uncertain.bodyText).status).toBe('INDETERMINATE');
    const retained = await fixture.handler(fixture.store(fixture.databaseB), { execute })
      .handle(fixture.handlerInput(fixture.envelope({ request, jobId: 'unknown-commit-job' })));
    expect(parseTaskResult(retained.bodyText)).toEqual(expected);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('leaves a tombstone when persistence fails after executor return and never redispatches', async () => {
    // Given result persistence that fails before its UPDATE after the executor returns.
    const probe = new ProbedRemoteJobDatabase(fixture.databaseA);
    probe.failBeforeNextResultCommit();
    const request = fixture.request('pre-result-commit-request');
    const execute = vi.fn(async () => taskPassResult(request.requestId));
    const handler = fixture.handler(fixture.store(probe), { execute });

    // When the first handler finishes and a restarted handler receives an exact fresh duplicate.
    const first = await handler.handle(fixture.handlerInput(
      fixture.envelope({ request, jobId: 'pre-result-commit-job' }),
    ));
    const rows = await scopedOwnerQuery<{
      readonly state: string; readonly result: unknown | null; readonly resultDigest: string | null;
    }>({
      owner: fixture.owner,
      projectId: fixture.primaryProjectId,
      query: `SELECT "state","result","resultDigest" FROM "BlroRemoteJob" WHERE "jobId"=$1`,
      values: ['pre-result-commit-job'],
    });
    const retry = await fixture.handler(fixture.store(fixture.databaseB), { execute })
      .handle(fixture.handlerInput(fixture.envelope({ request, jobId: 'pre-result-commit-job' })));

    // Then the committed tombstone remains authoritative and executor count stays one.
    expect(parseTaskResult(first.bodyText).status).toBe('INDETERMINATE');
    expect(rows).toEqual([{ state: 'dispatch_committed', result: null, resultDigest: null }]);
    expect(parseTaskResult(retry.bodyText).status).toBe('INDETERMINATE');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('refuses malformed, forged, expired, wrong-origin, and revoked authority before lookup', async () => {
    // Given a retained job and a query-counting authority store.
    const probe = new ProbedRemoteJobDatabase(fixture.databaseA);
    const request = fixture.request('authorization-order-request');
    const execute = vi.fn(async () => taskPassResult(request.requestId));
    const handler = fixture.handler(fixture.store(probe), { execute });
    await handler.handle(fixture.handlerInput(fixture.envelope({ request, jobId: 'protected-job' })));
    const before = probe.remoteJobLookups;
    const malformed = { ...fixture.envelope({ request, jobId: 'protected-job' }), capability: 'malformed' };
    const foreignKey = generateKeyPairSync('ed25519').privateKey
      .export({ format: 'pem', type: 'pkcs8' }).toString();
    const forged = fixture.envelope({ request, jobId: 'protected-job', privateKey: foreignKey });
    const wrongOriginRequest: BrowserExecutionRequest = { ...request, origin: 'https://other.task22.test' };
    const wrongOrigin = fixture.envelope({ request: wrongOriginRequest, jobId: 'protected-job' });
    const expired = fixture.envelope({ request, jobId: 'protected-job',
      issuedAt: new Date(fixture.now.getTime() - 60_000), expiresAt: fixture.now });

    // When invalid authority is presented, including revocation after retention.
    const invalid: readonly JobEnvelope[] = [malformed, forged, wrongOrigin, expired];
    const statuses: number[] = [];
    for (const envelope of invalid) statuses.push((await handler.handle(fixture.handlerInput(envelope))).statusCode);
    await fixture.revokePrimary();
    statuses.push((await handler.handle(fixture.handlerInput(
      fixture.envelope({ request, jobId: 'protected-job' }),
    ))).statusCode);

    // Then no invalid request consults or dispatches retained job state.
    expect(statuses).toEqual([403, 403, 403, 400, 403]);
    expect(probe.remoteJobLookups).toBe(before);
    expect(execute).toHaveBeenCalledOnce();
  });
});
