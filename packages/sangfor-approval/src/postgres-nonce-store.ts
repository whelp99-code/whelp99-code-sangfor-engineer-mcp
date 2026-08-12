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
 * The nonce is scoped by project: the same nonce value in another project is a
 * different nonce, matching the RLS row scope.
 */

export interface NonceConsumeResult {
  readonly ok: boolean;
  readonly reason?: string;
}

export interface PostgresNonceStoreOptions {
  readonly connectionString: string;
}

/** Strip credentials from anything that might carry a connection string. */
function scrub(message: string): string {
  return message.replace(/(postgres(?:ql)?:\/\/[^:@\s]+:)[^@\s]+@/gi, '$1***@');
}

export class PostgresSingleUseNonceStore {
  private client:
    | { $queryRawUnsafe: Function; $executeRawUnsafe: Function; $transaction: Function; $disconnect: Function }
    | undefined;
  private readonly connectionString: string;

  constructor(options: PostgresNonceStoreOptions) {
    this.connectionString = options.connectionString;
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
   * Consume `nonce` for `projectId`. Returns ok exactly once per (project,
   * nonce) while unexpired; every other outcome refuses.
   */
  async consume(
    projectId: string,
    nonce: string,
    expiresAt: string,
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
        return (await tx.$queryRawUnsafe(
          `INSERT INTO "BlroApprovalNonce" ("id", "projectId", "nonce", "expiresAt", "consumedAt")
           VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz)
           ON CONFLICT ("projectId", "nonce") DO NOTHING
           RETURNING "id"`,
          `${projectId}:${nonce}`,
          projectId,
          nonce,
          new Date(expiryMs).toISOString(),
          now.toISOString(),
        )) as unknown[];
      });

      if (Array.isArray(inserted) && inserted.length > 0) return { ok: true };
      return { ok: false, reason: `approval nonce already used: ${nonce}` };
    } catch (error) {
      const detail = scrub(error instanceof Error ? error.message : String(error));
      return { ok: false, reason: `nonce store unavailable (fail-closed): ${detail}` };
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
    if (this.client) {
      await this.client.$disconnect().catch(() => {});
      this.client = undefined;
    }
  }
}
