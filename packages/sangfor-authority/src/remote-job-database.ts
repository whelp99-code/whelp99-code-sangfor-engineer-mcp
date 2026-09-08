import type {
  EnrollmentDatabase,
  EnrollmentProjectScope,
  EnrollmentSqlExecutor,
} from './enrollment-database.js';

export type RemoteJobDatabase = EnrollmentDatabase;
export type RemoteJobTransactionInput<T> = {
  readonly database: RemoteJobDatabase;
  readonly scope: EnrollmentProjectScope;
  readonly maxAttempts: number;
  readonly work: (transaction: EnrollmentSqlExecutor) => Promise<T>;
};

export async function runRemoteJobTransaction<T>(
  input: RemoteJobTransactionInput<T>,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await input.database.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe(
          `SELECT set_config('app.project_id',$1,true)`,
          input.scope.projectId,
        );
        return input.work(transaction);
      });
    } catch (error) {
      if (!isRetryableTransactionError(error) || attempt >= input.maxAttempts) throw error;
    }
  }
}

export function isRetryableTransactionError(error: unknown): boolean {
  const code = databaseErrorCode(error);
  return code === 'P2034' || code === '40001' || code === '40P01';
}

function databaseErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if ('code' in error && typeof error.code === 'string') return error.code;
  return databaseErrorCode(error.cause);
}
