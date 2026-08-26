import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  RemoteJobDatabase,
  SqlExecutor,
} from '../../packages/sangfor-authority/src/index.js';

class TaskDatabaseFault extends Error {
  override readonly name = 'TaskDatabaseFault';
  constructor(readonly code: string) {
    super(`Task database fault: ${code}`);
  }
}

type TransactionState = {
  resultCommit: boolean;
};

class ProbedExecutor implements SqlExecutor {
  constructor(
    private readonly delegate: SqlExecutor,
    private readonly owner: ProbedRemoteJobDatabase,
    private readonly state: TransactionState,
  ) {}

  async $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number> {
    this.observe(query);
    if (this.owner.consumePreResultCommitFailure(query)) {
      throw new TaskDatabaseFault('RESULT_COMMIT_PRE_WRITE_FAILED');
    }
    return this.delegate.$executeRawUnsafe(query, ...values);
  }

  async $queryRawUnsafe<T = unknown[]>(query: string, ...values: unknown[]): Promise<T> {
    this.observe(query);
    return this.delegate.$queryRawUnsafe<T>(query, ...values);
  }

  private observe(query: string): void {
    if (/FROM "BlroRemoteJob"/u.test(query)) this.owner.remoteJobLookups += 1;
    if (/UPDATE "BlroRemoteJob" SET "state"='result_retained'/u.test(query)) {
      this.state.resultCommit = true;
    }
  }
}

/** Mutable fault/observation state is the purpose of this deterministic test adapter. */
export class ProbedRemoteJobDatabase implements RemoteJobDatabase {
  remoteJobLookups = 0;
  transactionAttempts = 0;
  private readonly transactionContext = new AsyncLocalStorage<boolean>();
  private readonly failures: string[] = [];
  private preResultCommitFailure = false;
  private postResultCommitUnknown = false;

  constructor(private readonly delegate: RemoteJobDatabase) {}

  failNextTransaction(code: string): void {
    this.failures.push(code);
  }

  failBeforeNextResultCommit(): void {
    this.preResultCommitFailure = true;
  }

  failAfterNextResultCommit(): void {
    this.postResultCommitUnknown = true;
  }

  consumePreResultCommitFailure(query: string): boolean {
    if (!this.preResultCommitFailure
      || !/UPDATE "BlroRemoteJob" SET "state"='result_retained'/u.test(query)) return false;
    this.preResultCommitFailure = false;
    return true;
  }

  isInTransaction(): boolean {
    return this.transactionContext.getStore() ?? false;
  }

  async $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number> {
    return this.delegate.$executeRawUnsafe(query, ...values);
  }

  async $queryRawUnsafe<T = unknown[]>(query: string, ...values: unknown[]): Promise<T> {
    return this.delegate.$queryRawUnsafe<T>(query, ...values);
  }

  async $transaction<T>(
    work: (transaction: SqlExecutor) => Promise<T>,
    options?: { readonly isolationLevel?: 'Serializable' },
  ): Promise<T> {
    this.transactionAttempts += 1;
    const failure = this.failures.shift();
    if (failure) throw new TaskDatabaseFault(failure);
    const state: TransactionState = { resultCommit: false };
    const value = await this.delegate.$transaction((transaction) => (
      this.transactionContext.run(true, () => work(new ProbedExecutor(transaction, this, state)))
    ), options);
    if (state.resultCommit && this.postResultCommitUnknown) {
      this.postResultCommitUnknown = false;
      throw new TaskDatabaseFault('RESULT_COMMIT_OUTCOME_UNKNOWN');
    }
    return value;
  }
}
