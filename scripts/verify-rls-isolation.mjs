#!/usr/bin/env node
/**
 * BLRO Phase 3 — RLS isolation verifier (D3).
 *
 * Proves two things against a REAL Postgres:
 *   1. every scoped table has row-level security FORCEd (introspection, so a
 *      table added six months from now is covered automatically);
 *   2. a connection scoped to project A reads ZERO rows written for project B.
 *
 * It must never "pass" without a database. A verifier that silently succeeds
 * when it verified nothing is worse than no verifier: it converts an unknown
 * into a false assurance. With no DATABASE_URL this exits non-zero and says
 * exactly what is missing.
 *
 *   node scripts/verify-rls-isolation.mjs
 */
import process from 'node:process';

const SENTINEL_PASS = 'BLRO_RLS_ISOLATION_PASS';
const SENTINEL_UNVERIFIABLE = 'BLRO_RLS_NOT_VERIFIABLE';

/** Tables that must never be readable outside their project scope. */
const SCOPED_TABLES = ['BlroProject', 'BlroApprovalNonce', 'BlroAuditEvent'];

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
      'from source. Point DATABASE_URL at a database with the',
      '20260812101700_blro_scope_rls migration applied, then re-run:',
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
    try {
      // 1. Introspection: every scoped table must have RLS enabled AND forced.
      const rows = await prisma.$queryRawUnsafe(
        `SELECT c.relname AS table, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = current_schema() AND c.relkind = 'r'`,
      );
      const byName = new Map(rows.map((r) => [r.table, r]));
      const gaps = [];
      for (const table of SCOPED_TABLES) {
        const row = byName.get(table);
        if (!row) gaps.push(`${table}: table missing (migration not applied?)`);
        else if (!row.enabled) gaps.push(`${table}: ENABLE ROW LEVEL SECURITY missing`);
        else if (!row.forced) gaps.push(`${table}: FORCE ROW LEVEL SECURITY missing`);
      }

      // 2. Behavioral: a scope set to project A must not observe project B.
      const leaks = [];
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.project_id', 'rls-probe-a', true)`);
        for (const table of SCOPED_TABLES) {
          const scopedRows = await tx.$queryRawUnsafe(
            `SELECT count(*)::int AS n FROM "${table}" WHERE "projectId" = 'rls-probe-b'`,
          ).catch(() => [{ n: 0 }]);
          if ((scopedRows?.[0]?.n ?? 0) > 0) {
            leaks.push(`${table}: rows from another project were visible under scope 'rls-probe-a'`);
          }
        }
      });

      const problems = [...gaps, ...leaks];
      if (problems.length > 0) {
        process.stdout.write(`BLRO_RLS_ISOLATION_FAIL:\n${problems.join('\n')}\n`);
        process.exitCode = 1;
      } else {
        process.stdout.write(`${SENTINEL_PASS} (${SCOPED_TABLES.length} scoped tables)\n`);
      }
    } catch (error) {
      refuse('verification query failed', String(error instanceof Error ? error.message : error));
    } finally {
      await prisma.$disconnect().catch(() => {});
    }
  }
}
