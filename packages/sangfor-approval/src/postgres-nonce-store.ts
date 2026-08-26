/**
 * Postgres-backed single-use approval nonce store (BLRO Phase 3, D5 step 1).
 *
 * Why this exists: `FileSingleUseNonceStore` is single-process safe only. It
 * read-modify-writes a JSON file under a directory lock, so the moment BLRO has
 * two replicas — the whole point of the JM/BLRO split — two callers can read the
 * same prior state and both conclude they consumed the nonce first. "Single use"
 * would silently become "use once per replica" on a control that gates real
 * device mutation.
 *
 * The database provides what a file cannot: a UNIQUE constraint plus an atomic
 * conditional write. The winner is decided by Postgres, not by application
 * timing.
 *
 * Fail-closed contract, preserved byte-compatibly with the file store:
 *  - any storage error REFUSES (never allows) — callers treat refusal as "do not
 *    execute";
 *  - a replay refuses with the caller-visible `approval nonce already used:`
 *    prefix that the operator and learning adapters match on.
 *
 * Nonce uniqueness is global. Approval signatures do not yet carry project
 * scope, so allowing the same value in another project would permit replay of
 * the same signed approval when deployments share an approval secret.
 */

export interface NonceConsumeResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly code?: 'ALREADY_USED' | 'STORE_UNAVAILABLE' | 'STALE_EPOCH';
}

interface NonceDatabase {
  $queryRawUnsafe: Function;
  $executeRawUnsafe: Function;
  $transaction: Function;
  $disconnect?: Function;
}

export type PostgresNonceStoreOptions =
  | { readonly connectionString: string; readonly database?: never }
  | { readonly database: NonceDatabase; readonly connectionString?: never };

/** Strip credentials from anything that might carry a connection string. */
function scrub(message: string): string {
  return message.replace(/(postgres(?:ql)?:\/\/[^:@\s]+:)[^@\s]+@/gi, '$1***@');
}

export class PostgresSingleUseNonceStore {
  private client: NonceDatabase | undefined;
  private readonly connectionString: string | undefined;
  private readonly ownsClient: boolean;

  constructor(options: PostgresNonceStoreOptions) {
    this.connectionString = options.connectionString;
    this.client = options.database;
    this.ownsClient = options.database === undefined;
  }

  private async getClient() {
    if (!this.client) {
      // Lazy require: importing @prisma/client eagerly runs its dotenv side
      // effect and leaks the repo .env into every importer (see the note in
      // packages/sangfor-store). Load it only when the store is actually used.
      const { createRequire } = await import('node:module');
      const requireModule = createRequire(import.meta.url);
      const { PrismaClient } = requireModule('@prisma/client') as typeof import('@prisma/client');
      this.client = new PrismaClient({
        datasources: { db: { url: this.connectionString } },
      }) as unknown as typeof this.client;
    }
    return this.client!;
  }

  /**
   * Consume `nonce` for `projectId`. Returns ok exactly once globally while
   * unexpired; every other outcome refuses.
   */
  async consume(
    projectId: string,
    nonce: string,
    expiresAt: string,
    authorityEpoch: number,
    now: Date = new Date(),
  ): Promise<NonceConsumeResult> {
    if (typeof projectId !== 'string' || projectId.length === 0) {
      return { ok: false, reason: 'invalid nonce input: projectId' };
    }
    if (typeof nonce !== 'string' || nonce.length === 0) {
      return { ok: false, reason: 'invalid nonce input: nonce' };
    }
    const expiryMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiryMs) || !Number.isFinite(now.getTime())) {
      return { ok: false, reason: 'invalid nonce input: expiresAt' };
    }
    if (expiryMs < now.getTime()) {
      return { ok: false, reason: `approval nonce expired: ${nonce}` };
    }

    try {
      const db = await this.getClient();
      // The row-level security policy is keyed to `app.project_id`, so the scope
      // MUST be set on the very same connection/transaction as the write —
      // otherwise the policy correctly refuses the insert (42501). This is the
      // enforcement working as intended: an unscoped writer cannot write.
      //
      // Atomic single-use: ON CONFLICT DO NOTHING makes the UNIQUE index the
      // arbiter, so the first inserter gets a row back and every racing caller
      // gets zero rows. No read-then-write window exists for a second winner.
      const inserted = await db.$transaction(async (tx: {
        $executeRawUnsafe: Function;
        $queryRawUnsafe: Function;
      }) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.project_id', $1, true)`, projectId);
        await tx.$executeRawUnsafe(
          `INSERT INTO "BlroProjectAuthorityEpoch" ("projectId","epoch","revision") SELECT "id",0,0 FROM "BlroProject" WHERE "id"=$1 ON CONFLICT DO NOTHING`, projectId,
        );
        const epochs = await tx.$queryRawUnsafe(
          `SELECT "epoch" FROM "BlroProjectAuthorityEpoch" WHERE "projectId"=$1 FOR SHARE`, projectId,
        ) as Array<{ epoch: number }>;
        if (epochs[0]?.epoch !== authorityEpoch) return { kind: 'stale' as const };
        const rows = (await tx.$queryRawUnsafe(
          `INSERT INTO "BlroApprovalNonce" ("id", "tenantId", "projectId", "nonce", "expiresAt", "consumedAt", "authorityEpoch")
           SELECT $1, p."tenantId", p."id", $3, $4::timestamptz, $5::timestamptz, $6
           FROM "BlroProject" p
           WHERE p."id" = $2
           ON CONFLICT ("nonce") DO NOTHING
           RETURNING "id"`,
          `${projectId}:${nonce}`,
          projectId,
          nonce,
          new Date(expiryMs).toISOString(),
          now.toISOString(),
          authorityEpoch,
        )) as unknown[];
        return rows.length > 0 ? { kind: 'inserted' as const } : { kind: 'duplicate' as const };
      });

      if (inserted.kind === 'inserted') return { ok: true };
      if (inserted.kind === 'stale') return { ok: false, code: 'STALE_EPOCH', reason: 'approval authority epoch is stale' };
      return { ok: false, code: 'ALREADY_USED', reason: `approval nonce already used: ${nonce}` };
    } catch (error) {
      const detail = scrub(error instanceof Error ? error.message : String(error));
      return { ok: false, code: 'STORE_UNAVAILABLE', reason: `nonce store unavailable (fail-closed): ${detail}` };
    }
  }

  /**
   * Test-only helper: clear consumed nonces across every project. Runs with a
   * scope set per project because RLS (correctly) hides rows from an unscoped
   * connection, so an unscoped DELETE would silently remove nothing.
   */
  async purgeForTest(projectIds: readonly string[] = ['proj-a', 'proj-b']): Promise<void> {
    const db = await this.getClient();
    for (const projectId of projectIds) {
      await db.$transaction(async (tx: { $executeRawUnsafe: Function }) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.project_id', $1, true)`, projectId);
        await tx.$executeRawUnsafe(`DELETE FROM "BlroApprovalNonce"`);
      });
    }
  }

  async close(): Promise<void> {
    if (this.client && this.ownsClient && this.client.$disconnect) {
      await this.client.$disconnect().catch(() => {});
      this.client = undefined;
    }
  }
}
