import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgvectorRagStore } from '../../packages/sangfor-rag/src/pgvector-store.js';
import { parsePgvectorCohort, parsePgvectorScope } from '../../packages/sangfor-rag/src/pgvector-schema.js';
import type {
  PgvectorDatabase,
  PgvectorSqlExecutor,
} from '../../packages/sangfor-rag/src/pgvector-types.js';

const databaseUrl = process.env['DATABASE_URL'];
const ownerUrl = process.env['BLRO_OWNER_DATABASE_URL'];
if (!databaseUrl || !ownerUrl || process.env['SANGFOR_REQUIRE_POSTGRES_TESTS'] !== '1') {
  throw new Error('MANDATORY_POSTGRES_DATABASE_REQUIRED');
}

type Deferred = {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
};

type TransactionSeam = {
  readonly beforeLock?: () => Promise<void>;
  readonly afterLock?: (values: readonly unknown[], result: unknown) => Promise<void>;
};

function deferred(): Deferred {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((ready) => { resolve = ready; });
  return { promise, resolve: () => resolve?.() };
}

function barrier(participants: number): () => Promise<void> {
  let arrived = 0;
  const released = deferred();
  return async () => {
    arrived += 1;
    if (arrived === participants) released.resolve();
    await released.promise;
  };
}

class PromotionTransactionDatabase implements PgvectorDatabase {
  constructor(
    private readonly inner: PrismaClient,
    private readonly seam: TransactionSeam,
  ) {}

  $executeRawUnsafe(query: string, ...values: readonly unknown[]): Promise<number> {
    return this.inner.$executeRawUnsafe(query, ...values);
  }

  $queryRawUnsafe<T>(query: string, ...values: readonly unknown[]): Promise<T> {
    return this.inner.$queryRawUnsafe<T>(query, ...values);
  }

  $transaction<T>(
    operation: (transaction: PgvectorSqlExecutor) => Promise<T>,
    options?: { readonly isolationLevel?: 'ReadCommitted' | 'Serializable' },
  ): Promise<T> {
    return this.inner.$transaction(async (transaction) => operation({
      $executeRawUnsafe: (query, ...values) => this.aroundLock(
        query, values, () => transaction.$executeRawUnsafe(query, ...values),
      ),
      $queryRawUnsafe: <Result>(query: string, ...values: readonly unknown[]) => this.aroundLock(
        query, values, () => transaction.$queryRawUnsafe<Result>(query, ...values),
      ),
    }), options);
  }

  private async aroundLock<Result>(
    query: string,
    values: readonly unknown[],
    execute: () => Promise<Result>,
  ): Promise<Result> {
    const promotionLock = query.includes('advisory_xact_lock');
    if (promotionLock) await this.seam.beforeLock?.();
    const result = await execute();
    if (promotionLock) await this.seam.afterLock?.(values, result);
    return result;
  }
}

const suffix = randomUUID();
const raceScope = parsePgvectorScope({
  tenantId: `cohort-race-tenant-${suffix}`,
  projectId: `cohort-race-project-${suffix}`,
  actorId: `cohort-race-actor-${suffix}`,
});
const independentScope = parsePgvectorScope({
  tenantId: `cohort-independent-tenant-${suffix}`,
  projectId: `cohort-independent-project-${suffix}`,
  actorId: `cohort-independent-actor-${suffix}`,
});
const owner = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
const first = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const second = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

function cohort(scope: typeof raceScope, id: string, indexEpoch: number) {
  return parsePgvectorCohort({ ...scope, id, indexEpoch, backend: 'hash', model: 'hash-v1', dimensions: 384 });
}

async function activeCohorts(scope: typeof raceScope): Promise<readonly { id: string }[]> {
  return first.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, scope.projectId);
    return transaction.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT "id" FROM "BlroRagEmbeddingCohort" WHERE "tenantId"=$1 AND "projectId"=$2 AND "active"=true`,
      scope.tenantId, scope.projectId,
    );
  });
}

describe('pgvector cohort promotion concurrency', () => {
  beforeAll(async () => {
    for (const scope of [raceScope, independentScope]) {
      await owner.$executeRawUnsafe(
        `INSERT INTO "BlroTenant" ("id","name") VALUES ($1,'cohort concurrency')`,
        scope.tenantId,
      );
      await owner.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, scope.projectId);
        await transaction.$executeRawUnsafe(
          `INSERT INTO "BlroProject" ("id","tenantId","name") VALUES ($1,$2,'cohort concurrency')`,
          scope.projectId, scope.tenantId,
        );
      });
    }
  });

  afterAll(async () => {
    for (const scope of [raceScope, independentScope]) {
      await owner.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, scope.projectId);
        await transaction.$executeRawUnsafe(
          `DELETE FROM "BlroRagEmbeddingCohort" WHERE "tenantId"=$1 AND "projectId"=$2`,
          scope.tenantId, scope.projectId,
        );
        await transaction.$executeRawUnsafe(`DELETE FROM "BlroProject" WHERE "id"=$1`, scope.projectId);
      });
      await owner.$executeRawUnsafe(`DELETE FROM "BlroTenant" WHERE "id"=$1`, scope.tenantId);
    }
    await Promise.all([owner.$disconnect(), first.$disconnect(), second.$disconnect()]);
  });

  it('Given two epochs in one empty scope, When promotion lock statements overlap, Then both serialize and one remains active', async () => {
    // Given
    const beforeLock = barrier(2);
    const firstStore = new PgvectorRagStore(new PromotionTransactionDatabase(first, { beforeLock }));
    const secondStore = new PgvectorRagStore(new PromotionTransactionDatabase(second, { beforeLock }));

    // When
    const outcomes = await Promise.allSettled([
      firstStore.promoteCohort(cohort(raceScope, `race-a-${suffix}`, 101)),
      secondStore.promoteCohort(cohort(raceScope, `race-b-${suffix}`, 102)),
    ]);

    // Then
    expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true);
    expect(await activeCohorts(raceScope)).toHaveLength(1);
  });

  it('Given one active epoch, When another epoch is inserted active, Then scope uniqueness refuses it', async () => {
    // Given / When
    const insertion = first.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, raceScope.projectId);
      await transaction.$executeRawUnsafe(
        `INSERT INTO "BlroRagEmbeddingCohort"
          ("id","tenantId","projectId","indexEpoch","backend","model","dimensions","active")
         VALUES ($1,$2,$3,999,'hash','hash-v1',384,true)`,
        `scope-duplicate-${suffix}`, raceScope.tenantId, raceScope.projectId,
      );
    });

    // Then
    await expect(insertion).rejects.toBeDefined();
  });

  it('Given one scope holds its promotion lock, When another scope promotes, Then it commits independently', async () => {
    // Given
    const held = deferred();
    const release = deferred();
    const heldDatabase = new PromotionTransactionDatabase(first, {
      afterLock: async (values) => {
        if (values.includes(raceScope.projectId)) {
          held.resolve();
          await release.promise;
        }
      },
    });
    const heldPromotion = new PgvectorRagStore(heldDatabase).promoteCohort(
      cohort(raceScope, `race-c-${suffix}`, 103),
    );
    await held.promise;

    try {
      // When
      await new PgvectorRagStore(second).promoteCohort(
        cohort(independentScope, `independent-${suffix}`, 201),
      );

      // Then
      expect(await activeCohorts(independentScope)).toHaveLength(1);
    } finally {
      release.resolve();
      await heldPromotion;
    }
  });
});
