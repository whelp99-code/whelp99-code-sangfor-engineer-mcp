import { randomUUID } from 'node:crypto';
import { browserExecutionResultSchema, type BrowserExecutionResult } from './browser-execution.js';
import {
  persistedEnrollmentRecordSchema,
  type PersistedEnrollmentRecord,
} from './enrollment-schemas.js';
import type { JobIdempotencyStore } from './remote-handler.js';

interface SqlExecutor {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  $queryRawUnsafe<T = unknown[]>(query: string, ...values: unknown[]): Promise<T>;
}

export interface ScopedStoreDatabase extends SqlExecutor {
  $transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

async function scoped<T>(
  database: ScopedStoreDatabase,
  projectId: string,
  work: (transaction: SqlExecutor) => Promise<T>,
): Promise<T> {
  return database.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(
      `SELECT set_config('app.project_id', $1, true)`,
      projectId,
    );
    return work(transaction);
  });
}

export class PostgresEnrollmentStore {
  constructor(
    private readonly database: ScopedStoreDatabase,
    private readonly projectId: string,
  ) {}

  async getByInstallation(installationId: string): Promise<PersistedEnrollmentRecord | undefined> {
    const rows = await scoped(this.database, this.projectId, (transaction) =>
      transaction.$queryRawUnsafe<readonly { readonly record: unknown }[]>(
        `SELECT "record" FROM "BlroClientEnrollment" WHERE "projectId"=$1 AND "installationId"=$2
         ORDER BY ("record"->>'status'='active') DESC, "updatedAt" DESC LIMIT 1`,
        this.projectId,
        installationId,
      ));
    const row = rows[0];
    return row ? persistedEnrollmentRecordSchema.parse(row.record) : undefined;
  }

  async getBySerial(certificateSerial: string): Promise<PersistedEnrollmentRecord | undefined> {
    const rows = await scoped(this.database, this.projectId, (transaction) =>
      transaction.$queryRawUnsafe<readonly { readonly record: unknown }[]>(
        `SELECT "record" FROM "BlroClientEnrollment" WHERE "projectId"=$1 AND "certificateSerial"=$2`,
        this.projectId,
        certificateSerial,
      ));
    const row = rows[0];
    return row ? persistedEnrollmentRecordSchema.parse(row.record) : undefined;
  }

  async put(record: PersistedEnrollmentRecord): Promise<void> {
    const parsed = persistedEnrollmentRecordSchema.parse(record);
    await scoped(this.database, this.projectId, (transaction) =>
      transaction.$executeRawUnsafe(
        `INSERT INTO "BlroClientEnrollment" ("id","tenantId","projectId","installationId","certificateSerial","record")
         SELECT $1,p."tenantId",p."id",$3,$4,$5::jsonb FROM "BlroProject" p WHERE p."id"=$2
         ON CONFLICT ("projectId","certificateSerial") DO UPDATE SET
           "record"=EXCLUDED."record","updatedAt"=CURRENT_TIMESTAMP`,
        randomUUID(),
        this.projectId,
        parsed.installationId,
        parsed.certificateSerial,
        JSON.stringify(parsed),
      )).then(() => undefined);
  }
}

export class PostgresJobIdempotencyStore implements JobIdempotencyStore {
  constructor(
    private readonly database: ScopedStoreDatabase,
    private readonly projectId: string,
  ) {}

  async get(jobId: string): Promise<BrowserExecutionResult | undefined> {
    const rows = await scoped(this.database, this.projectId, (transaction) =>
      transaction.$queryRawUnsafe<readonly { readonly result: unknown }[]>(
        `SELECT "result" FROM "BlroBrowserJobResult" WHERE "projectId"=$1 AND "jobId"=$2`,
        this.projectId,
        jobId,
      ));
    const row = rows[0];
    return row ? browserExecutionResultSchema.parse(row.result) : undefined;
  }

  async put(jobId: string, result: BrowserExecutionResult): Promise<void> {
    const parsed = browserExecutionResultSchema.parse(result);
    await scoped(this.database, this.projectId, (transaction) =>
      transaction.$queryRawUnsafe(
        `INSERT INTO "BlroBrowserJobResult" ("id","tenantId","projectId","jobId","result")
         SELECT $1,p."tenantId",p."id",$3,$4::jsonb FROM "BlroProject" p WHERE p."id"=$2
         ON CONFLICT ("jobId") DO UPDATE SET "result"="BlroBrowserJobResult"."result"
         WHERE "BlroBrowserJobResult"."projectId"=$2 RETURNING "id"`,
        randomUUID(),
        this.projectId,
        jobId,
        JSON.stringify(parsed),
      )).then(() => undefined);
  }
}
