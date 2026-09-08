#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AUTHORITY_MANIFEST } from '../packages/sangfor-authority/src/migration-manifest.js';
import {
  deriveOwnershipExpectations,
  deriveScopedAuthorityModels,
  deriveTenantProjectModels,
  projectColumnFor,
} from './lib/scoped-authority-models.js';
import { seedRlsProject, type RlsProjectFixture } from './lib/rls-fixtures.js';
import { verifyRlsOperationMatrix } from './lib/rls-operation-matrix.js';

const CatalogTableSchema = z.object({ table: z.string(), enabled: z.boolean(), forced: z.boolean() });
const ColumnSchema = z.object({ table: z.string(), column: z.string(), notnull: z.boolean() });
const IndexSchema = z.object({ table: z.string(), columns: z.array(z.string()) });
const PolicySchema = z.object({ table: z.string(), name: z.string(), command: z.string(), permissive: z.boolean(), roles: z.array(z.number()), using: z.string().nullable(), check: z.string().nullable() });
const ForeignKeySchema = z.object({ table: z.string(), parent: z.string(), action: z.string(), columns: z.array(z.string()), references: z.array(z.string()) });
const RoleSchema = z.object({ role: z.string(), superuser: z.boolean(), bypass: z.boolean(), owner: z.boolean() });

type Database = PrismaClient;
class RlsVerificationRollback extends Error { readonly name = 'RlsVerificationRollback'; }

function normalizePolicy(value: string | null): string {
  return (value ?? '').replaceAll('"', '').replaceAll('::text', '').replace(/[()\s]/gu, '');
}

async function catalogProblems(database: Database, expected: readonly string[], schema: string): Promise<readonly string[]> {
  const problems: string[] = [];
  const tables = z.array(CatalogTableSchema).parse(await database.$queryRawUnsafe(`SELECT c.relname AS "table",c.relrowsecurity AS enabled,c.relforcerowsecurity AS forced FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind='r'`));
  const columns = z.array(ColumnSchema).parse(await database.$queryRawUnsafe(`SELECT c.relname AS "table",a.attname AS column,a.attnotnull AS notnull FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped WHERE n.nspname=current_schema() AND c.relkind='r'`));
  const indexes = z.array(IndexSchema).parse(await database.$queryRawUnsafe(`SELECT t.relname AS "table",array_agg(a.attname ORDER BY keys.ordinality) AS columns FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY keys(attnum,ordinality) JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=keys.attnum WHERE n.nspname=current_schema() GROUP BY t.relname,i.indexrelid`));
  const policies = z.array(PolicySchema).parse(await database.$queryRawUnsafe(`SELECT c.relname AS "table",p.polname AS name,p.polcmd AS command,p.polpermissive AS permissive,p.polroles::int[] AS roles,pg_get_expr(p.polqual,p.polrelid) AS using,pg_get_expr(p.polwithcheck,p.polrelid) AS check FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema()`));
  const foreignKeys = z.array(ForeignKeySchema).parse(await database.$queryRawUnsafe(`SELECT child.relname AS "table",parent.relname AS parent,con.confdeltype::text AS action,array_agg(a.attname ORDER BY keys.ordinality) AS columns,array_agg(r.attname ORDER BY keys.ordinality) AS references FROM pg_constraint con JOIN pg_class child ON child.oid=con.conrelid JOIN pg_class parent ON parent.oid=con.confrelid JOIN pg_namespace n ON n.oid=child.relnamespace CROSS JOIN LATERAL unnest(con.conkey,con.confkey) WITH ORDINALITY keys(attnum,refattnum,ordinality) JOIN pg_attribute a ON a.attrelid=child.oid AND a.attnum=keys.attnum JOIN pg_attribute r ON r.attrelid=parent.oid AND r.attnum=keys.refattnum WHERE n.nspname=current_schema() AND con.contype='f' GROUP BY child.relname,parent.relname,con.confdeltype,con.oid`));
  const roles = z.array(RoleSchema).parse(await database.$queryRawUnsafe(`SELECT r.rolname AS role,r.rolsuper AS superuser,r.rolbypassrls AS bypass,(r.oid=c.relowner) AS owner FROM pg_roles r CROSS JOIN (SELECT relowner FROM pg_class WHERE relname=$1 AND relnamespace=(SELECT oid FROM pg_namespace WHERE nspname=current_schema())) c WHERE r.rolname=current_user OR r.oid=c.relowner`, expected[0]));
  const expectedSet = new Set(expected);
  const actualScoped = columns.filter((row) => row.table.startsWith('Blro') && row.column === 'projectId').map((row) => row.table);
  for (const table of actualScoped) if (!expectedSet.has(table)) problems.push(`${table}: unscoped authority table is absent from canonical derivation`);
  for (const table of expected) {
    const relation = tables.find((row) => row.table === table);
    const projectColumn = projectColumnFor(table);
    const column = columns.find((row) => row.table === table && row.column === projectColumn);
    if (!relation) problems.push(`${table}: table missing`);
    else { if (!relation.enabled) problems.push(`${table}: ENABLE RLS missing`); if (!relation.forced) problems.push(`${table}: FORCE RLS missing`); }
    if (!column?.notnull) problems.push(`${table}.${projectColumn}: non-null scope missing`);
    if (!indexes.some((row) => row.table === table && row.columns.includes(projectColumn))) problems.push(`${table}.${projectColumn}: index missing`);
    const tablePolicies = policies.filter((policy) => policy.table === table);
    const expression = normalizePolicy(`${projectColumn} = current_setting('app.project_id', true)`);
    if (tablePolicies.length !== 1) problems.push(`${table}: expected exactly one policy, found ${tablePolicies.length}`);
    const policy = tablePolicies[0];
    if (!policy || policy.name !== `${table}_scope` || policy.command !== '*' || !policy.permissive
      || policy.roles.length !== 1 || policy.roles[0] !== 0
      || normalizePolicy(policy.using) !== expression || normalizePolicy(policy.check) !== expression) {
      problems.push(`${table}: project policy is not exact USING/WITH CHECK for PUBLIC ALL`);
    }
  }
  for (const policy of policies) if (policy.table.startsWith('Blro') && !expectedSet.has(policy.table)) problems.push(`${policy.table}: extra authority policy ${policy.name}`);
  for (const model of deriveTenantProjectModels(schema, expected)) {
    if (!foreignKeys.some((key) => key.table === model.table && key.parent === 'BlroProject'
      && key.columns.join(',') === 'tenantId,projectId' && key.references.join(',') === 'tenantId,id')) {
      problems.push(`${model.table}: exact composite tenant/project ownership FK is missing`);
    }
  }
  if (!foreignKeys.some((key) => key.table === 'BlroLocalWriteIntent' && key.parent === 'BlroMembership'
    && key.columns.join(',') === 'tenantId,projectId,actorId'
    && key.references.join(',') === 'tenantId,projectId,actorId')) {
    problems.push('BlroLocalWriteIntent: exact composite actor membership FK is missing');
  }
  for (const ownership of deriveOwnershipExpectations(schema, expected)) {
    const action = ownership.deleteAction === 'CASCADE' ? 'c' : 'r';
    if (!foreignKeys.some((key) => key.table === ownership.table && key.parent === ownership.parent
      && key.action === action && key.columns.includes(ownership.ownershipColumn))) {
      problems.push(`${ownership.table}: ${ownership.deleteAction} ownership by ${ownership.parent} is missing`);
    }
  }
  if (roles.length !== 2 || roles.some((role) => role.superuser || role.bypass) || roles.filter((role) => role.owner).length !== 1) {
    problems.push('runtime and owner roles must be distinct NOSUPERUSER NOBYPASSRLS roles');
  }
  return problems;
}

async function isolationProblems(
  database: Database,
  tables: readonly string[],
  schema: string,
): Promise<{ readonly problems: readonly string[]; readonly matrixCells: number }> {
  const suffix = randomUUID();
  const fixtures: readonly RlsProjectFixture[] = ['a1', 'a2', 'b1', 'b2'].map((label) => ({
    label: `${label}-${suffix}`, tenantId: `tenant-${label[0]}-${suffix}`, projectId: `project-${label}-${suffix}`,
    actorId: `actor-${label}-${suffix}`, roleId: `role-${label[0]}-${suffix}`,
  }));
  const problems: string[] = [];
  const rollback = new RlsVerificationRollback();
  let matrixCells = 0;
  try {
    await database.$transaction(async (transaction) => {
      for (const tenant of ['a', 'b']) await transaction.$executeRawUnsafe(`INSERT INTO "BlroTenant" ("id","name") VALUES ($1,$2)`, `tenant-${tenant}-${suffix}`, `RLS tenant ${tenant}`);
      for (const tenant of ['a', 'b']) await transaction.$executeRawUnsafe(`INSERT INTO "BlroRole" ("id","tenantId","name","permissions") VALUES ($1,$2,$3,ARRAY['probe:write'])`, `role-${tenant}-${suffix}`, `tenant-${tenant}-${suffix}`, `probe-${tenant}-${suffix}`);
      for (const fixture of fixtures) {
        await transaction.$executeRawUnsafe(`INSERT INTO "BlroActor" ("id","tenantId","displayName","actorType") VALUES ($1,$2,$3,'service')`, fixture.actorId, fixture.tenantId, fixture.label);
        await seedRlsProject(transaction, fixture);
      }
      const own = fixtures[0];
      if (!own) throw rollback;
      for (const fixture of fixtures) {
        await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, fixture.projectId);
        for (const table of tables) {
          const column = projectColumnFor(table);
          const rows = await transaction.$queryRawUnsafe<Array<{ count: number }>>(`SELECT count(*)::int AS count FROM "${table}" WHERE "${column}"=$1`, fixture.projectId);
          if (rows[0]?.count !== 1) problems.push(`${table}: ${fixture.projectId} fixture is vacuous`);
        }
      }
      const matrix = await verifyRlsOperationMatrix(
        transaction,
        tables,
        fixtures,
        deriveTenantProjectModels(schema, tables),
      );
      matrixCells = matrix.cells.length;
      problems.push(...matrix.problems);
      await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, own.projectId);
      await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, fixtures[1]?.projectId ?? 'missing');
      const stale = await transaction.$queryRawUnsafe<Array<{ count: number }>>(`SELECT count(*)::int AS count FROM "BlroProject" WHERE "id"=$1`, own.projectId);
      if (stale[0]?.count !== 0) problems.push('pooled transaction retained stale project scope');
      throw rollback;
    }, { isolationLevel: 'Serializable', maxWait: 10_000, timeout: 60_000 });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  return { problems, matrixCells };
}

async function main(): Promise<void> {
  if (!process.argv.includes('--require')) throw new Error('BLRO_RLS_REQUIRE_FLAG_REQUIRED');
  const databaseUrl = process.env['DATABASE_URL']?.trim();
  if (!databaseUrl) throw new Error('BLRO_RLS_NOT_VERIFIABLE: DATABASE_URL is not set');
  const schema = readFileSync('prisma/schema.prisma', 'utf8');
  const tables = deriveScopedAuthorityModels(schema, AUTHORITY_MANIFEST);
  const database = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const isolation = await isolationProblems(database, tables, schema);
    const problems = [...await catalogProblems(database, tables, schema), ...isolation.problems];
    if (problems.length > 0) throw new Error(`BLRO_RLS_ISOLATION_FAIL:\n${problems.join('\n')}`);
    process.stdout.write(`BLRO_RLS_ISOLATION_PASS (${tables.length} derived tables, ${isolation.matrixCells} exhaustive matrix cells: ${tables.join(', ')})\n`);
  } finally {
    await database.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
