#!/usr/bin/env node
/**
 * BLRO Phase 3 RLS isolation verifier (D3).
 *
 * This verifier is deliberately non-vacuous: inside a transaction that is
 * always rolled back, it creates complete project A and B lineages, proves A
 * can see every A sentinel, and proves A cannot see any B sentinel.
 */
import { randomUUID } from 'node:crypto';
import process from 'node:process';

const SENTINEL_PASS = 'BLRO_RLS_ISOLATION_PASS';
const SENTINEL_UNVERIFIABLE = 'BLRO_RLS_NOT_VERIFIABLE';

const SCOPED_TABLES = [
  'BlroProject', 'BlroMembership', 'BlroApprovalNonce', 'BlroAuditEvent',
  'BlroDevice', 'BlroRun', 'BlroRunStep', 'BlroApproval',
  'BlroEvidenceManifest', 'BlroRagDocument', 'BlroRagChunk',
  'BlroEnrollmentIdentity', 'BlroEnrollmentCertificate', 'BlroEnrollmentGrant',
  'BlroEnrollmentBootstrapToken', 'BlroEnrollmentRotation',
  'BlroRemoteJobCapabilityJti', 'BlroRemoteJob',
];

function refuse(reason, detail) {
  process.stdout.write(`${SENTINEL_UNVERIFIABLE}: ${reason}\n`);
  if (detail) process.stdout.write(`${detail}\n`);
  process.exitCode = 1;
}

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  refuse(
    'DATABASE_URL is not set',
    [
      'RLS enforcement is a property of a running Postgres and cannot be inferred',
      'from source. Point DATABASE_URL at a database with all migrations applied, then re-run:',
      '',
      '  export DATABASE_URL=postgresql://user:pass@host:5432/db',
      '  pnpm exec prisma migrate deploy',
      '  node scripts/verify-rls-isolation.mjs',
      '',
      `Tables that must be covered: ${SCOPED_TABLES.join(', ')}.`,
    ].join('\n'),
  );
} else {
  let PrismaClient;
  try {
    ({ PrismaClient } = await import('@prisma/client'));
  } catch (error) {
    refuse('@prisma/client is not available', String(error instanceof Error ? error.message : error));
  }

  if (PrismaClient) {
    const prisma = new PrismaClient();
    const gaps = [];
    const leaks = [];
    const rollbackProbe = new Error('BLRO_RLS_PROBE_ROLLBACK');
    const suffix = randomUUID();
    const tenantId = `rls-tenant-${suffix}`;
    const roleId = `rls-role-${suffix}`;
    const projectA = `rls-project-a-${suffix}`;
    const projectB = `rls-project-b-${suffix}`;
    const actorA = `rls-actor-a-${suffix}`;
    const actorB = `rls-actor-b-${suffix}`;

    const seedProject = async (tx, projectId, actorId, label) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.project_id', $1, true)`, projectId);
      await tx.$executeRawUnsafe(
        `INSERT INTO "BlroProject" ("id","tenantId","name") VALUES ($1,$2,$3)`,
        projectId, tenantId, `RLS probe ${label}`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "BlroMembership" ("id","tenantId","projectId","actorId","roleId") VALUES ($1,$2,$3,$4,$5)`,
        `membership-${label}-${suffix}`, tenantId, projectId, actorId, roleId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "BlroApprovalNonce" ("id","tenantId","projectId","nonce","expiresAt","consumedAt") VALUES ($1,$2,$3,$4,now() + interval '1 hour',now())`,
        `nonce-${label}-${suffix}`, tenantId, projectId, `nonce-value-${label}-${suffix}`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "BlroAuditEvent" ("id","tenantId","projectId","seq","actorId","kind","payload","prevHash","hash") VALUES ($1,$2,$3,0,$4,'rls.probe','{}','GENESIS',$5)`,
        `audit-${label}-${suffix}`, tenantId, projectId, actorId, `hash-${label}-${suffix}`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "BlroDevice" ("id","tenantId","projectId","createdByActorId","name","product","host","metadata") VALUES ($1,$2,$3,$4,$5,'probe','127.0.0.1','{}')`,
        `device-${label}-${suffix}`, tenantId, projectId, actorId, `device-${label}-${suffix}`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "BlroRun" ("id","tenantId","projectId","actorId","status","toolProfileVersion","sourceSystem") VALUES ($1,$2,$3,$4,'created','probe-v1','rls-verifier')`,
        `run-${label}-${suffix}`, tenantId, projectId, actorId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "BlroRunStep" ("id","tenantId","projectId","runId","actorId","ordinal","status","payload") VALUES ($1,$2,$3,$4,$5,0,'created','{}')`,
        `step-${label}-${suffix}`, tenantId, projectId, `run-${label}-${suffix}`, actorId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "BlroApproval" ("id","tenantId","projectId","actorId","actionHash","expiresAt","status") VALUES ($1,$2,$3,$4,$5,now() + interval '1 hour','approved')`,
        `approval-${label}-${suffix}`, tenantId, projectId, actorId, `action-${label}-${suffix}`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "BlroEvidenceManifest" ("id","tenantId","projectId","actorId","runId","contentHash","manifest") VALUES ($1,$2,$3,$4,$5,$6,'{}')`,
        `evidence-${label}-${suffix}`, tenantId, projectId, actorId, `run-${label}-${suffix}`, `evidence-hash-${label}-${suffix}`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "BlroRagDocument" ("id","tenantId","projectId","actorId","title","sourceRef","contentHash","provenance") VALUES ($1,$2,$3,$4,$5,$6,$7,'{}')`,
        `document-${label}-${suffix}`, tenantId, projectId, actorId, `document ${label}`, `probe:${label}`, `document-hash-${label}-${suffix}`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "BlroRagChunk" ("id","tenantId","projectId","documentId","text","contentHash","aclActorIds") VALUES ($1,$2,$3,$4,$5,$6,'{}')`,
        `chunk-${label}-${suffix}`, tenantId, projectId, `document-${label}-${suffix}`, `chunk ${label}`, `chunk-hash-${label}-${suffix}`,
      );
      const enrollmentId = `enrollment-${label}-${suffix}`;
      const installationId = `installation-${label}-${suffix}`;
      const oldSerial = `serial-old-${label}-${suffix}`;
      const newSerial = `serial-new-${label}-${suffix}`;
      await tx.$executeRawUnsafe(
        `INSERT INTO "BlroEnrollmentIdentity" ("id","tenantId","projectId","installationId","deviceBindingDigest","clientIdentityId","state","revision","currentCertificateSerial","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,repeat($5,64),$6,'active',2,$7,now(),now())`,
        enrollmentId, tenantId, projectId, installationId, label,
        `client-${label}-${suffix}`, newSerial,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "BlroEnrollmentCertificate" ("id","tenantId","projectId","enrollmentId","issuerChainRef","issuer","subjectAltNames","extendedKeyUsages","serial","fingerprintSha256","notBefore","notAfter","state","revision","createdAt") VALUES
         ($1,$2,$3,$4,repeat('f',64),'CN=RLS',ARRAY['urn:rls:installation','urn:rls:device'],ARRAY['1.3.6.1.5.5.7.3.2'],$5,repeat($6,64),now()-interval '1 minute',now()+interval '1 hour','active',2,now())`,
        `cert-new-${label}-${suffix}`, tenantId, projectId, enrollmentId, newSerial,
        label === 'a' ? 'c' : 'd',
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "BlroEnrollmentGrant" ("id","tenantId","projectId","enrollmentId","originDigest","scope","revision","createdAt") VALUES ($1,$2,$3,$4,repeat($5,64),'browser:execute',1,now())`,
        `grant-${label}-${suffix}`, tenantId, projectId, enrollmentId, label,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "BlroEnrollmentBootstrapToken" ("id","tenantId","projectId","installationId","deviceBindingDigest","tokenDigest","grants","expiresAt","revision","createdAt") VALUES ($1,$2,$3,$4,repeat($5,64),repeat($6,64),'[]',now()+interval '5 minutes',0,now())`,
        `token-${label}-${suffix}`, tenantId, projectId, `token-install-${label}-${suffix}`,
        label, label === 'a' ? 'e' : 'f',
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "BlroEnrollmentRotation" ("id","tenantId","projectId","enrollmentId","oldSerial","newSerial","overlapExpiresAt","requestDigest","revision","createdAt") VALUES ($1,$2,$3,$4,$5,$6,now()+interval '5 minutes',repeat('a',64),2,now())`,
        `rotation-${label}-${suffix}`, tenantId, projectId, enrollmentId, oldSerial, newSerial,
      );
      const remoteJti = `remote-jti-${label}-${suffix}`;
      const remoteJob = `remote-job-${label}-${suffix}`;
      await tx.$executeRawUnsafe(
        `INSERT INTO "BlroRemoteJobCapabilityJti" ("jti","tenantId","projectId","installationId","jobId","requestDigest","capabilityExpiresAt","consumedAt") VALUES ($1,$2,$3,$4,$5,repeat($6,64),now()+interval '1 hour',now())`,
        remoteJti, tenantId, projectId, installationId, remoteJob, label,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "BlroRemoteJob" ("id","tenantId","projectId","installationId","jobId","runId","stepId","requestId","requestDigest","capabilityJti","state","tombstoneCommittedAt","createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,repeat($9,64),$10,'dispatch_committed',now(),now(),now())`,
        `remote-dispatch-${label}-${suffix}`, tenantId, projectId, installationId, remoteJob,
        `remote-run-${label}-${suffix}`, `remote-step-${label}-${suffix}`,
        `remote-request-${label}-${suffix}`, label, remoteJti,
      );
    };

    try {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT c.relname AS table, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = current_schema() AND c.relkind = 'r'`,
      );
      const byName = new Map(rows.map((row) => [row.table, row]));
      for (const table of SCOPED_TABLES) {
        const row = byName.get(table);
        if (!row) gaps.push(`${table}: table missing (migration not applied?)`);
        else if (!row.enabled) gaps.push(`${table}: ENABLE ROW LEVEL SECURITY missing`);
        else if (!row.forced) gaps.push(`${table}: FORCE ROW LEVEL SECURITY missing`);
      }

      const nonceIndexes = await prisma.$queryRawUnsafe(
        `SELECT i.relname AS indexname,
                ix.indisunique,
                array_agg(a.attname ORDER BY key.ordinality) AS columns
           FROM pg_index ix
           JOIN pg_class t ON t.oid = ix.indrelid
           JOIN pg_class i ON i.oid = ix.indexrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
           CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS key(attnum, ordinality)
           JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = key.attnum
          WHERE n.nspname = current_schema() AND t.relname = 'BlroApprovalNonce'
          GROUP BY i.relname, ix.indisunique`,
      );
      if (!nonceIndexes.some((row) =>
        row.indisunique
        && Array.isArray(row.columns)
        && row.columns.length === 1
        && row.columns[0] === 'nonce'
      )) {
        gaps.push('BlroApprovalNonce: global nonce UNIQUE index missing');
      }
      if (nonceIndexes.some((row) => row.indexname === 'BlroApprovalNonce_projectId_nonce_key')) {
        gaps.push('BlroApprovalNonce: obsolete project-scoped nonce UNIQUE index remains');
      }

      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO "BlroTenant" ("id","name") VALUES ($1,$2)`, tenantId, `RLS probe ${suffix}`,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO "BlroActor" ("id","tenantId","displayName","actorType") VALUES ($1,$2,'Probe A','service'),($3,$2,'Probe B','service')`,
          actorA, tenantId, actorB,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO "BlroRole" ("id","tenantId","name","permissions") VALUES ($1,$2,'probe',ARRAY['probe:read'])`,
          roleId, tenantId,
        );
        await seedProject(tx, projectA, actorA, 'a');
        await seedProject(tx, projectB, actorB, 'b');

        await tx.$executeRawUnsafe(`SELECT set_config('app.project_id', $1, true)`, projectA);
        for (const table of SCOPED_TABLES) {
          const projectColumn = table === 'BlroProject' ? 'id' : 'projectId';
          const ownRows = await tx.$queryRawUnsafe(
            `SELECT count(*)::int AS n FROM "${table}" WHERE "${projectColumn}" = $1`, projectA,
          );
          const foreignRows = await tx.$queryRawUnsafe(
            `SELECT count(*)::int AS n FROM "${table}" WHERE "${projectColumn}" = $1`, projectB,
          );
          if ((ownRows?.[0]?.n ?? 0) !== 1) {
            leaks.push(`${table}: project A sentinel was not visible (probe was vacuous)`);
          }
          if ((foreignRows?.[0]?.n ?? 0) !== 0) {
            leaks.push(`${table}: project B sentinel was visible under project A scope`);
          }
        }
        throw rollbackProbe;
      }).catch((error) => {
        if (error !== rollbackProbe) throw error;
      });

      const problems = [...gaps, ...leaks];
      if (problems.length > 0) {
        process.stdout.write(`BLRO_RLS_ISOLATION_FAIL:\n${problems.join('\n')}\n`);
        process.exitCode = 1;
      } else {
        process.stdout.write(`${SENTINEL_PASS} (${SCOPED_TABLES.length} non-vacuously scoped tables)\n`);
      }
    } catch (error) {
      refuse('verification query failed', String(error instanceof Error ? error.message : error));
    } finally {
      await prisma.$disconnect().catch(() => {});
    }
  }
}
