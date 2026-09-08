import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserExecutionResult } from '../packages/sangfor-browser-contracts/src/index.js';
import { remoteJobResultDigest } from '../packages/sangfor-authority/src/remote-job-result.js';
import { RemoteJobAuthorityFixture } from './helpers/remote-job-authority-fixture.js';
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

type CorruptResult = {
  readonly result: unknown;
  readonly digest: string;
  readonly databaseNull?: true;
};
type CorruptionCase = {
  readonly name: string;
  readonly corrupt: (original: BrowserExecutionResult) => CorruptResult;
};
const CORRUPTIONS: readonly CorruptionCase[] = [
  {
    name: 'malformed JSON contract',
    corrupt: () => ({ result: '{not-a-result', digest: '1'.repeat(64) }),
  },
  {
    name: 'result digest mismatch',
    corrupt: (original) => ({ result: original, digest: '2'.repeat(64) }),
  },
  {
    name: 'completed state with SQL NULL result',
    corrupt: () => ({ result: null, digest: '3'.repeat(64), databaseNull: true }),
  },
  {
    name: 'completed state with missing result fields',
    corrupt: () => ({ result: {}, digest: '4'.repeat(64) }),
  },
  {
    name: 'result requestId mismatch with matching digest',
    corrupt: () => {
      const result = taskPassResult('another-request-id', 'forged-matching-digest');
      return { result, digest: remoteJobResultDigest(result) };
    },
  },
] as const;

async function retainJob(jobId: string, requestId: string) {
  const request = fixture.request(requestId);
  const result = taskPassResult(requestId, jobId);
  const execute = vi.fn(async () => result);
  const handler = fixture.handler(fixture.store(), { execute });
  await handler.handle(fixture.handlerInput(fixture.envelope({ request, jobId })));
  return { request, result, execute, handler };
}

describe.runIf(runPostgres)('Todo 22 PostgreSQL retained-result integrity', () => {
  beforeAll(async () => {
    fixture = await RemoteJobAuthorityFixture.create(databaseUrl, ownerUrl);
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());

  it.each(CORRUPTIONS)('returns INDETERMINATE for $name without redispatch', async ({ name, corrupt }) => {
    // Given one digest-verified retained result and a scoped corruption variant.
    const jobId = `corrupt-${name.replaceAll(/[^a-z]+/giu, '-').toLowerCase()}`;
    const retained = await retainJob(jobId, `${jobId}-request`);
    const corrupted = corrupt(retained.result);
    const mutation = corrupted.databaseNull
      ? {
          query: `UPDATE "BlroRemoteJob" SET "result"=NULL,"resultDigest"=$1 WHERE "jobId"=$2`,
          values: [corrupted.digest, jobId],
        }
      : {
          query: `UPDATE "BlroRemoteJob" SET "result"=$1::jsonb,"resultDigest"=$2 WHERE "jobId"=$3`,
          values: [JSON.stringify(corrupted.result), corrupted.digest, jobId],
        };
    const affected = await scopedOwnerExecute({
      owner: fixture.owner,
      projectId: fixture.primaryProjectId,
      ...mutation,
    });
    expect(affected).toBe(1);
    const stored = await scopedOwnerQuery<{
      readonly state: string; readonly result: unknown; readonly resultDigest: string | null;
    }>({
      owner: fixture.owner,
      projectId: fixture.primaryProjectId,
      query: `SELECT "state","result","resultDigest" FROM "BlroRemoteJob" WHERE "jobId"=$1`,
      values: [jobId],
    });
    expect(stored).toEqual([{
      state: 'result_retained', result: corrupted.result, resultDigest: corrupted.digest,
    }]);

    // When a fresh authorized duplicate reads the corrupt retained row.
    const response = await retained.handler.handle(fixture.handlerInput(
      fixture.envelope({ request: retained.request, jobId }),
    ));

    // Then corruption never becomes PASS and the external executor remains at one call.
    expect(parseTaskResult(response.bodyText).status).toBe('INDETERMINATE');
    expect(retained.execute).toHaveBeenCalledOnce();
  });

  it('ignores a forged result attached to a dispatch tombstone and never dispatches', async () => {
    // Given a committed tombstone with no executor call and a scoped forged payload.
    const request = fixture.request('forged-tombstone-request');
    const jobId = 'forged-tombstone-job';
    const envelope = fixture.envelope({ request, jobId });
    const reserved = await fixture.store().authorizeAndReserve({
      envelope,
      certificate: { encoding: 'der-base64', value: fixture.certificates.validDerBase64 },
    });
    expect(reserved.kind).toBe('dispatch');
    const forged = taskPassResult(request.requestId, 'forged-tombstone');
    const digest = remoteJobResultDigest(forged);
    const affected = await scopedOwnerExecute({
      owner: fixture.owner,
      projectId: fixture.primaryProjectId,
      query: `UPDATE "BlroRemoteJob" SET "result"=$1::jsonb,"resultDigest"=$2 WHERE "jobId"=$3`,
      values: [JSON.stringify(forged), digest, jobId],
    });
    expect(affected).toBe(1);
    const stored = await scopedOwnerQuery<{
      readonly state: string; readonly result: unknown; readonly resultDigest: string | null;
    }>({
      owner: fixture.owner,
      projectId: fixture.primaryProjectId,
      query: `SELECT "state","result","resultDigest" FROM "BlroRemoteJob" WHERE "jobId"=$1`,
      values: [jobId],
    });
    expect(stored).toEqual([{ state: 'dispatch_committed', result: forged, resultDigest: digest }]);
    const execute = vi.fn(async () => taskPassResult(request.requestId));

    // When a restarted handler receives a fresh exact duplicate.
    const response = await fixture.handler(fixture.store(fixture.databaseB), { execute })
      .handle(fixture.handlerInput(fixture.envelope({ request, jobId })));

    // Then tombstone state wins over the forged payload and no executor runs.
    expect(parseTaskResult(response.bodyText).status).toBe('INDETERMINATE');
    expect(execute).not.toHaveBeenCalled();
  });
});
