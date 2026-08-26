import { createHash } from 'node:crypto';
import { z } from 'zod';
import { projectColumnFor, type TenantProjectModel } from './scoped-authority-models.js';
import type { RlsProjectFixture } from './rls-fixtures.js';

type SqlExecutor = {
  $executeRawUnsafe(query: string, ...values: readonly unknown[]): Promise<number>;
  $queryRawUnsafe<T>(query: string, ...values: readonly unknown[]): Promise<T>;
};

type MatrixScope = 'unscoped' | 'exact' | 'same_tenant_cross_project' | 'cross_tenant';
type MatrixOperation = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
export type MatrixCell = {
  readonly table: string;
  readonly operation: MatrixOperation | 'OWNERSHIP_MISMATCH';
  readonly scope: MatrixScope | 'cross_tenant_ownership';
  readonly result: 'ALLOWED' | 'HIDDEN' | 'RLS_REFUSED' | 'DOMAIN_REFUSED' | 'FK_REFUSED';
};

type MutationResult = { readonly count: number } | { readonly error: unknown };
const JsonRowSchema = z.object({ row: z.string() });
const PrimaryKeySchema = z.object({ table: z.string(), columns: z.array(z.string()) });
const DatabaseErrorSchema = z.object({ meta: z.object({ code: z.string() }) });

function transformedRow(
  table: string,
  row: string,
  source: RlsProjectFixture,
  target: RlsProjectFixture,
): string {
  const parsed = z.record(z.unknown()).parse(JSON.parse(row.replaceAll(source.label, target.label)));
  if ('tenantId' in parsed) parsed['tenantId'] = target.tenantId;
  if ('projectId' in parsed) parsed['projectId'] = target.projectId;
  if ('roleId' in parsed) parsed['roleId'] = target.roleId;
  const digest = createHash('sha256').update(`${table}:${target.label}`).digest('hex');
  if (table === 'BlroAuditEvent') parsed['seq'] = 999;
  if (table === 'BlroEnrollmentBootstrapToken') parsed['tokenDigest'] = digest;
  if (table === 'BlroEnrollmentCertificate') parsed['fingerprintSha256'] = digest;
  if (table === 'BlroEnrollmentRotation') parsed['requestDigest'] = digest;
  return JSON.stringify(parsed);
}

async function mutation(
  database: SqlExecutor,
  query: string,
  values: readonly unknown[],
): Promise<MutationResult> {
  await database.$executeRawUnsafe('SAVEPOINT matrix_cell');
  try {
    const count = await database.$executeRawUnsafe(query, ...values);
    await database.$executeRawUnsafe('ROLLBACK TO SAVEPOINT matrix_cell');
    await database.$executeRawUnsafe('RELEASE SAVEPOINT matrix_cell');
    return { count };
  } catch (error) {
    await database.$executeRawUnsafe('ROLLBACK TO SAVEPOINT matrix_cell');
    await database.$executeRawUnsafe('RELEASE SAVEPOINT matrix_cell');
    return { error };
  }
}

function classifyRejected(result: MutationResult): 'RLS_REFUSED' | 'DOMAIN_REFUSED' {
  return 'error' in result ? 'RLS_REFUSED' : 'DOMAIN_REFUSED';
}

export async function verifyRlsOperationMatrix(
  database: SqlExecutor,
  tables: readonly string[],
  fixtures: readonly RlsProjectFixture[],
  tenantProjectModels: readonly TenantProjectModel[],
): Promise<{ readonly cells: readonly MatrixCell[]; readonly problems: readonly string[] }> {
  const own = fixtures[0];
  const sameTenant = fixtures[1];
  const crossTenant = fixtures[2];
  if (!own || !sameTenant || !crossTenant) throw new Error('RLS_MATRIX_FIXTURES_INCOMPLETE');
  const primaryKeys = new Map(z.array(PrimaryKeySchema).parse(await database.$queryRawUnsafe(`
    SELECT child.relname AS table,array_agg(a.attname ORDER BY keys.ordinality) AS columns
    FROM pg_constraint c
    JOIN pg_class child ON child.oid=c.conrelid
    CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY keys(attnum,ordinality)
    JOIN pg_attribute a ON a.attrelid=child.oid AND a.attnum=keys.attnum
    WHERE c.contype='p' AND child.relname=ANY($1::text[])
    GROUP BY child.relname
  `, tables)).map((key) => [key.table, key.columns]));
  const rows = new Map<string, ReadonlyMap<string, string>>();
  for (const table of tables) {
    const byProject = new Map<string, string>();
    for (const fixture of [own, sameTenant, crossTenant]) {
      await database.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, fixture.projectId);
      const result = z.array(JsonRowSchema).parse(await database.$queryRawUnsafe(
        `SELECT to_jsonb(t)::text AS row FROM "${table}" t WHERE "${projectColumnFor(table)}"=$1`, fixture.projectId,
      ));
      const row = result[0]?.row;
      if (!row) throw new Error(`RLS_MATRIX_SOURCE_MISSING: ${table}:${fixture.projectId}`);
      byProject.set(fixture.projectId, row);
    }
    rows.set(table, byProject);
  }

  const scopes: readonly { readonly scope: MatrixScope; readonly setting: string; readonly target: RlsProjectFixture }[] = [
    { scope: 'unscoped', setting: '', target: own },
    { scope: 'exact', setting: own.projectId, target: own },
    { scope: 'same_tenant_cross_project', setting: own.projectId, target: sameTenant },
    { scope: 'cross_tenant', setting: own.projectId, target: crossTenant },
  ];
  const cells: MatrixCell[] = [];
  const problems: string[] = [];
  for (const table of tables) {
    const projectColumn = projectColumnFor(table);
    for (const scope of scopes) {
      await database.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, scope.setting);
      const selected = await database.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM "${table}" WHERE "${projectColumn}"=$1`, scope.target.projectId,
      );
      const selectCount = selected[0]?.count ?? -1;
      const selectExpected = scope.scope === 'exact' ? 1 : 0;
      cells.push({ table, operation: 'SELECT', scope: scope.scope, result: selectCount === 1 ? 'ALLOWED' : 'HIDDEN' });
      if (selectCount !== selectExpected) problems.push(`${table}: SELECT ${scope.scope} returned ${selectCount}`);

      const source = rows.get(table)?.get(scope.target.projectId);
      if (!source) throw new Error(`RLS_MATRIX_ROW_MISSING: ${table}:${scope.scope}`);
      const conflictColumns = primaryKeys.get(table)?.map((column) => `"${column}"`).join(',');
      if (!conflictColumns) throw new Error(`RLS_MATRIX_PRIMARY_KEY_MISSING: ${table}`);
      const inserted = await mutation(database,
        `INSERT INTO "${table}" SELECT (jsonb_populate_record(NULL::"${table}",$1::jsonb)).* ON CONFLICT (${conflictColumns}) DO UPDATE SET "${projectColumn}"=EXCLUDED."${projectColumn}"`,
        [source],
      );
      const insertAllowed = !('error' in inserted) && inserted.count === 1;
      const insertDomainRefused = scope.scope === 'exact' && table === 'BlroAuditEvent' && 'error' in inserted;
      cells.push({ table, operation: 'INSERT', scope: scope.scope, result: insertAllowed ? 'ALLOWED' : insertDomainRefused ? 'DOMAIN_REFUSED' : classifyRejected(inserted) });
      if (!(insertAllowed === (scope.scope === 'exact' && table !== 'BlroAuditEvent') || insertDomainRefused)) problems.push(`${table}: INSERT ${scope.scope} classification invalid`);

      const updated = await mutation(database,
        `UPDATE "${table}" SET "${projectColumn}"="${projectColumn}" WHERE "${projectColumn}"=$1`,
        [scope.target.projectId],
      );
      const updateCount = 'count' in updated ? updated.count : -1;
      const updateAllowed = updateCount === 1;
      const updateDomainRefused = scope.scope === 'exact' && table === 'BlroAuditEvent' && 'error' in updated;
      cells.push({ table, operation: 'UPDATE', scope: scope.scope, result: updateAllowed ? 'ALLOWED' : updateDomainRefused ? 'DOMAIN_REFUSED' : updateCount === 0 ? 'HIDDEN' : classifyRejected(updated) });
      if (!(updateAllowed === (scope.scope === 'exact' && table !== 'BlroAuditEvent') || updateDomainRefused || (scope.scope !== 'exact' && updateCount === 0))) {
        problems.push(`${table}: UPDATE ${scope.scope} classification invalid`);
      }

      const deleted = await mutation(database, `DELETE FROM "${table}" WHERE "${projectColumn}"=$1`, [scope.target.projectId]);
      const deleteCount = 'count' in deleted ? deleted.count : -1;
      const deleteAllowed = deleteCount === 1;
      const deleteDomainRefused = scope.scope === 'exact' && 'error' in deleted;
      cells.push({ table, operation: 'DELETE', scope: scope.scope, result: deleteAllowed ? 'ALLOWED' : deleteDomainRefused ? 'DOMAIN_REFUSED' : deleteCount === 0 ? 'HIDDEN' : classifyRejected(deleted) });
      if (!(scope.scope === 'exact' ? deleteAllowed || deleteDomainRefused : deleteCount === 0)) problems.push(`${table}: DELETE ${scope.scope} classification invalid`);
    }
  }

  for (const model of tenantProjectModels) {
    const source = rows.get(model.table)?.get(own.projectId);
    if (!source) throw new Error(`RLS_MATRIX_OWNERSHIP_ROW_MISSING: ${model.table}`);
    const mismatched = transformedRow(model.table, source, own, { ...own, label: `mismatch-${own.label}`, tenantId: crossTenant.tenantId });
    await database.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, own.projectId);
    const result = await mutation(database, `INSERT INTO "${model.table}" SELECT (jsonb_populate_record(NULL::"${model.table}",$1::jsonb)).*`, [mismatched]);
    const code = 'error' in result ? DatabaseErrorSchema.safeParse(result.error).data?.meta.code : undefined;
    const refusedByForeignKey = code === '23503';
    cells.push({ table: model.table, operation: 'OWNERSHIP_MISMATCH', scope: 'cross_tenant_ownership', result: refusedByForeignKey ? 'FK_REFUSED' : 'ALLOWED' });
    if (!refusedByForeignKey) problems.push(`${model.table}: cross-tenant ownership mismatch was not rejected by FK (code=${code ?? 'none'})`);
  }

  const expectedCells = tables.length * 4 * scopes.length + tenantProjectModels.length;
  if (cells.length !== expectedCells) problems.push(`matrix coverage incomplete: expected ${expectedCells}, got ${cells.length}`);
  return { cells, problems };
}
