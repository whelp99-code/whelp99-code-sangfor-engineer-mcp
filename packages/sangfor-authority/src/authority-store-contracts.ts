export interface SqlExecutor {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  $queryRawUnsafe<T = unknown[]>(query: string, ...values: unknown[]): Promise<T>;
}

export interface AuthorityDatabase extends SqlExecutor {
  $transaction<T>(
    work: (transaction: SqlExecutor) => Promise<T>,
    options?: { readonly isolationLevel?: 'Serializable' | 'ReadCommitted' },
  ): Promise<T>;
}

export interface AuthorityActorScope {
  readonly tenantId: string;
  readonly projectId: string;
  readonly actorId: string;
}
