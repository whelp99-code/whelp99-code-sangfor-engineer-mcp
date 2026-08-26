import { randomUUID } from 'node:crypto';
import {
  browserExecutionResultSchema,
  type BrowserExecutionResult,
  type JobIdempotencyStore,
} from '@sangfor/browser-contracts';
import {
  inEnrollmentScope,
  type EnrollmentDatabase,
  type EnrollmentProjectScope,
} from './enrollment-database.js';

export class PostgresJobIdempotencyStore implements JobIdempotencyStore {
  constructor(
    private readonly database: EnrollmentDatabase,
    private readonly scope: EnrollmentProjectScope,
  ) {}

  async get(jobId: string): Promise<BrowserExecutionResult | undefined> {
    const rows = await inEnrollmentScope(this.database, this.scope, (transaction) => (
      transaction.$queryRawUnsafe<readonly { readonly result: unknown }[]>(
        `SELECT "result" FROM "BlroBrowserJobResult" WHERE "projectId"=$1 AND "jobId"=$2`,
        this.scope.projectId,
        jobId,
      )
    ));
    const row = rows[0];
    return row ? browserExecutionResultSchema.parse(row.result) : undefined;
  }

  async put(jobId: string, result: BrowserExecutionResult): Promise<void> {
    const parsed = browserExecutionResultSchema.parse(result);
    await inEnrollmentScope(this.database, this.scope, (transaction) => (
      transaction.$queryRawUnsafe(
        `INSERT INTO "BlroBrowserJobResult" ("id","tenantId","projectId","jobId","result")
         SELECT $1,p."tenantId",p."id",$3,$4::jsonb FROM "BlroProject" p WHERE p."id"=$2
         ON CONFLICT ("jobId") DO UPDATE SET "result"="BlroBrowserJobResult"."result"
         WHERE "BlroBrowserJobResult"."projectId"=$2 RETURNING "id"`,
        randomUUID(), this.scope.projectId, jobId, JSON.stringify(parsed),
      ).then(() => undefined)
    ));
  }
}
