import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  resolveCutoverAdapter,
  PostgresCutoverRepository,
  canonicalRecordSet,
  parseCutoverRecord,
} from '../packages/sangfor-authority/src/index.js';
import type { AuthorityAggregate } from '../packages/sangfor-authority/src/migration-manifest.js';

const databaseUrl = process.env.AUTHORITY_CUTOVER_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const suffix = randomUUID();
const scope = {
  tenantId: `target-tenant-${suffix}`, projectId: `target-project-${suffix}`, actorId: `target-actor-${suffix}`,
};
const roleId = `target-role-${suffix}`;
const genericAggregates = [
  'pm_tasks', 'feedback_lessons', 'evals', 'wiki_proposals', 'learning_strategy_lifecycle',
  'config_chronicle_state', 'capability_evidence_promotion',
] as const;
const coreAggregates = ['registry_services', 'runs_steps', 'audit', 'evidence'] as const;

function payload(aggregate: AuthorityAggregate): Readonly<Record<string, unknown>> {
  if (aggregate === 'registry_services') return { id: `device-${suffix}`, name: 'device', product: 'HCI', host: '127.0.0.1', tags: [], createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z' };
  if (aggregate === 'runs_steps') return { schemaVersion: 1, runId: `run-${suffix}`, toolId: 'tool', toolSafety: 'read_only', args: {}, status: 'succeeded', requestedAt: '2026-08-26T00:00:00.000Z' };
  if (aggregate === 'audit') return { seq: 0, at: '2026-08-26T00:00:00.000Z', runId: `audit-run-${suffix}`, kind: 'request', payload: {}, prevHash: 'GENESIS', hash: 'source-hash', keyed: false };
  return { id: `${aggregate}-${suffix}`, value: aggregate };
}
function record(aggregate: AuthorityAggregate) {
  return parseCutoverRecord({
    key: `${aggregate.length}:${aggregate}:${suffix}`, payload: payload(aggregate),
    provenance: {
      tenantId: scope.tenantId, projectId: scope.projectId, sourceRoot: '/tmp/generated-target-source',
      source: aggregate === 'registry_services' ? 'data/registry/devices.json' : `${aggregate}.jsonl`,
      ordinal: 0, sourceSha256: 'a'.repeat(64),
    },
  });
}

describeDatabase('aggregate-owned PostgreSQL cutover targets', () => {
  let prisma: PrismaClient;
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$executeRawUnsafe(`INSERT INTO "BlroTenant" ("id","name") VALUES ($1,'target tenant')`, scope.tenantId);
    await prisma.$executeRawUnsafe(`INSERT INTO "BlroActor" ("id","tenantId","displayName","actorType") VALUES ($1,$2,'target actor','human_pm')`, scope.actorId, scope.tenantId);
    await prisma.$executeRawUnsafe(`INSERT INTO "BlroRole" ("id","tenantId","name","permissions") VALUES ($1,$2,'target role',$3)`, roleId, scope.tenantId, ['registry:write', 'audit:append']);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, scope.projectId);
      await tx.$executeRawUnsafe(`INSERT INTO "BlroProject" ("id","tenantId","name") VALUES ($1,$2,'target project')`, scope.projectId, scope.tenantId);
      await tx.$executeRawUnsafe(`INSERT INTO "BlroMembership" ("id","projectId","actorId","tenantId","roleId") VALUES ($1,$2,$3,$4,$5)`, `membership-${suffix}`, scope.projectId, scope.actorId, scope.tenantId, roleId);
    });
  });

  afterAll(async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, scope.projectId);
      await tx.$executeRawUnsafe(`DELETE FROM "BlroAuthorityCutoverStaging" WHERE "projectId"=$1`, scope.projectId);
      for (const table of ['BlroCapabilityEvidence','BlroConfigChronicle','BlroEvalRecord','BlroFeedbackLesson','BlroLearningRecord','BlroPmRecord','BlroWikiProposal','BlroEvidenceManifest','BlroRunStep','BlroRun','BlroAuditEvent','BlroServiceRegistry','BlroDevice']) {
        await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "projectId"=$1`, scope.projectId);
      }
      await tx.$executeRawUnsafe(`DELETE FROM "BlroAuthorityCutover" WHERE "projectId"=$1`, scope.projectId);
      await tx.$executeRawUnsafe(`DELETE FROM "BlroMembership" WHERE "projectId"=$1`, scope.projectId);
      await tx.$executeRawUnsafe(`DELETE FROM "BlroProjectAuthorityEpoch" WHERE "projectId"=$1`, scope.projectId);
      await tx.$executeRawUnsafe(`DELETE FROM "BlroProject" WHERE "id"=$1`, scope.projectId);
    });
    await prisma.$executeRawUnsafe(`DELETE FROM "BlroRole" WHERE "id"=$1`, roleId);
    await prisma.$executeRawUnsafe(`DELETE FROM "BlroActor" WHERE "id"=$1`, scope.actorId);
    await prisma.$executeRawUnsafe(`DELETE FROM "BlroTenant" WHERE "id"=$1`, scope.tenantId);
    await prisma.$disconnect();
  });

  it('refuses a conflicting existing device key without changing its bytes', async () => {
    const aggregate = 'registry_services' as const; const conflictId = `conflict-device-${suffix}`;
    await prisma.$transaction(async (tx) => { await tx.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`,scope.projectId); await tx.$executeRawUnsafe(`INSERT INTO "BlroDevice" ("id","tenantId","projectId","createdByActorId","name","product","host","metadata") VALUES ($1,$2,$3,$4,'existing','HCI','192.0.2.1','{}')`,conflictId,scope.tenantId,scope.projectId,scope.actorId); });
    const baseRecord=record(aggregate);const expected=parseCutoverRecord({...baseRecord,payload:{...baseRecord.payload,id:conflictId,name:'incoming',host:'192.0.2.2'}});
    const resolved = resolveCutoverAdapter(aggregate,{...scope,database:prisma,sourceRoot:'.',expectedFiles:[]}); if(resolved.policy!=='backfill')throw new Error('policy');
    await new PostgresCutoverRepository(prisma).apply({projectId:scope.projectId,aggregate},{kind:'START_BACKFILL',highWaterMark:'conflict-hwm',expectedRevision:0});
    await expect(resolved.target.stage({projectId:scope.projectId,highWaterMark:'conflict-hwm',records:[expected]})).rejects.toThrow('TARGET_KEY_CONFLICT');
    const rows=await prisma.$transaction(async tx=>{await tx.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`,scope.projectId);return tx.$queryRawUnsafe<Array<{name:string;host:string}>>(`SELECT "name","host" FROM "BlroDevice" WHERE "id"=$1`,conflictId);});expect(rows).toEqual([{name:'existing',host:'192.0.2.1'}]);await new PostgresCutoverRepository(prisma).apply({projectId:scope.projectId,aggregate},{kind:'ROLLBACK',expectedRevision:1});await prisma.$transaction(async tx=>{await tx.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`,scope.projectId);await tx.$executeRawUnsafe(`DELETE FROM "BlroAuthorityCutover" WHERE "projectId"=$1 AND "aggregate"=$2`,scope.projectId,aggregate);});
  });

  it('keeps a conflicting existing run unchanged and reports TARGET_KEY_CONFLICT',async()=>{
    const aggregate='runs_steps' as const;const expected=record(aggregate);const runId=String(expected.payload['runId']);
    await prisma.$transaction(async tx=>{await tx.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`,scope.projectId);await tx.$executeRawUnsafe(`INSERT INTO "BlroRun" ("id","tenantId","projectId","actorId","status","toolProfileVersion","sourceSystem","authorityEpoch") VALUES ($1,$2,$3,$4,'failed','existing','existing',0)`,runId,scope.tenantId,scope.projectId,scope.actorId);});
    const repository=new PostgresCutoverRepository(prisma);await repository.apply({projectId:scope.projectId,aggregate},{kind:'START_BACKFILL',highWaterMark:'run-conflict',expectedRevision:0});const resolved=resolveCutoverAdapter(aggregate,{...scope,database:prisma,sourceRoot:'.',expectedFiles:[]});if(resolved.policy!=='backfill')throw new Error('policy');await expect(resolved.target.stage({projectId:scope.projectId,highWaterMark:'run-conflict',records:[expected]})).rejects.toThrow('TARGET_KEY_CONFLICT');const rows=await prisma.$transaction(async tx=>{await tx.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`,scope.projectId);return tx.$queryRawUnsafe<Array<{status:string;sourceSystem:string}>>(`SELECT "status","sourceSystem" FROM "BlroRun" WHERE "id"=$1`,runId);});expect(rows).toEqual([{status:'failed',sourceSystem:'existing'}]);await repository.apply({projectId:scope.projectId,aggregate},{kind:'ROLLBACK',expectedRevision:1});await prisma.$transaction(async tx=>{await tx.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`,scope.projectId);await tx.$executeRawUnsafe(`DELETE FROM "BlroRun" WHERE "id"=$1`,runId);await tx.$executeRawUnsafe(`DELETE FROM "BlroAuthorityCutover" WHERE "projectId"=$1 AND "aggregate"=$2`,scope.projectId,aggregate);});
  });

  it('upserts and reads back all eleven backfill aggregates idempotently from their real target tables', async () => {
    const repository = new PostgresCutoverRepository(prisma);
    for (const aggregate of [...coreAggregates, ...genericAggregates]) {
      const expected = record(aggregate);
      const resolved = resolveCutoverAdapter(aggregate, {
        ...scope, database: prisma, sourceRoot: '.', expectedFiles: [], auditSecret: 'target-audit-secret',
        promotionLedgerSecret: 'target-promotion-secret',
      });
      if (resolved.policy !== 'backfill') throw new Error('expected backfill adapter');
      const adapter = resolved.target;
      await repository.apply(
        { projectId: scope.projectId, aggregate },
        { kind: 'START_BACKFILL', highWaterMark: 'hwm', expectedRevision: 0 },
      );
      await adapter.stage({ projectId: scope.projectId, highWaterMark: 'hwm', records: [expected] });
      await adapter.stage({ projectId: scope.projectId, highWaterMark: 'hwm', records: [expected] });
      const actual = await adapter.canonicalRecords(scope.projectId, 'hwm');
      expect(canonicalRecordSet(actual)).toEqual(canonicalRecordSet([expected]));
      await adapter.cleanup(scope.projectId);
      await expect(adapter.canonicalRecords(scope.projectId, 'hwm')).resolves.toHaveLength(0);
    }
  });

  it('holds final target readback inside freeze and refuses cleanup after the fence', async () => {
    const aggregate = 'wiki_proposals' as const; const expected = record(aggregate);
    const resolved = resolveCutoverAdapter(aggregate, { ...scope, database: prisma, sourceRoot: '.', expectedFiles: [] });
    if (resolved.policy !== 'backfill') throw new Error('expected backfill adapter');
    const adapter = resolved.target;
    const repository = new PostgresCutoverRepository(prisma);
    await adapter.stage({ projectId: scope.projectId, highWaterMark: 'hwm', records: [expected] });
    const digest = canonicalRecordSet([expected]).digest;
    const shadow = await repository.apply(
      { projectId: scope.projectId, aggregate },
      { kind: 'VERIFY_BACKFILL', sourceDigest: digest, targetDigest: digest, expectedRevision: 1 },
    );
    await repository.freezeVerified({ projectId: scope.projectId, aggregate }, {
      at: '2026-08-26T00:00:00.000Z', expectedRevision: shadow.revision,
      verifyFinalParity: async (tx) => {
        expect(canonicalRecordSet(await adapter.canonicalRecords(scope.projectId, 'hwm', tx)).digest).toBe(digest);
      },
    });
    await expect(adapter.cleanup(scope.projectId)).rejects.toThrow('CUTOVER_ROLLBACK_REFUSED');
  });

  it('exposes target deletion as a parity mismatch instead of trusting the checkpoint table', async () => {
    const aggregate = 'evals' as const; const expected = record(aggregate);
    const resolved = resolveCutoverAdapter(aggregate, { ...scope, database: prisma, sourceRoot: '.', expectedFiles: [] });
    if (resolved.policy !== 'backfill') throw new Error('expected backfill adapter');
    const adapter = resolved.target;
    await adapter.stage({ projectId: scope.projectId, highWaterMark: 'hwm', records: [expected] });
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, scope.projectId);
      await tx.$executeRawUnsafe(`DELETE FROM "BlroEvalRecord" WHERE "projectId"=$1`, scope.projectId);
    });
    expect(canonicalRecordSet(await adapter.canonicalRecords(scope.projectId, 'hwm')).digest)
      .not.toBe(canonicalRecordSet([expected]).digest);
  });
});
