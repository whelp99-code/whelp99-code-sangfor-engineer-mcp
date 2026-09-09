import type { AuthorityActorScope, AuthorityDatabase, SqlExecutor } from '../../packages/sangfor-authority/src/authority-store-contracts.js';

type CaseRow = Record<string, unknown>;
type ArtifactRow = Record<string, unknown>;

export class FakeAuthorityDatabaseError extends Error {
  readonly name = 'FakeAuthorityDatabaseError';
}

export class FakeEngineerCaseAuthorityDatabase implements AuthorityDatabase {
  projectId = '';
  failOn?: { readonly table: string; readonly verb: 'INSERT' | 'UPDATE' | 'DELETE' };
  unavailable = false;
  readonly cases = new Map<string, CaseRow>();
  readonly artifacts = new Map<string, ArtifactRow>();
  readonly memberships = new Map<string, { scope: AuthorityActorScope; permissions: readonly string[] }>();
  private queue: Promise<unknown> = Promise.resolve();

  grant(scope: AuthorityActorScope, permissions: readonly string[]): void {
    this.memberships.set(`${scope.tenantId}:${scope.projectId}:${scope.actorId}`, { scope, permissions });
  }

  snapshot(): { cases: Array<[string, CaseRow]>; artifacts: Array<[string, ArtifactRow]> } {
    return {
      cases: [...this.cases.entries()].map(([key, value]) => [key, { ...value }]),
      artifacts: [...this.artifacts.entries()].map(([key, value]) => [key, { ...value }]),
    };
  }

  restore(snapshot: { cases: Array<[string, CaseRow]>; artifacts: Array<[string, ArtifactRow]> }): void {
    this.cases.clear();
    this.artifacts.clear();
    for (const [key, value] of snapshot.cases) this.cases.set(key, { ...value });
    for (const [key, value] of snapshot.artifacts) this.artifacts.set(key, { ...value });
  }

  async $transaction<T>(
    work: (transaction: SqlExecutor) => Promise<T>,
  ): Promise<T> {
    if (this.unavailable) throw new FakeAuthorityDatabaseError('STORE_UNAVAILABLE');
    const run = this.queue.then(async () => {
      const before = this.snapshot();
      try {
        return await work(this);
      } catch (error) {
        this.restore(before);
        throw error;
      }
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number> {
    return this.dispatch(query, values, 'execute') as Promise<number>;
  }

  async $queryRawUnsafe<T = unknown[]>(query: string, ...values: unknown[]): Promise<T> {
    return this.dispatch(query, values, 'query') as Promise<T>;
  }

  private async dispatch(query: string, values: readonly unknown[], mode: 'execute' | 'query'): Promise<unknown> {
    if (this.unavailable) throw new FakeAuthorityDatabaseError('STORE_UNAVAILABLE');
    if (/set_config\('app\.project_id'/u.test(query)) {
      this.projectId = String(values[0] ?? '');
      return mode === 'execute' ? 0 : [];
    }
    if (query.includes('AS "tenantActive"')) return this.authorize(values);
    if (query.includes('"BlroEngineerCaseArtifact"')) return this.artifactSql(query, values, mode);
    if (query.includes('"BlroEngineerCase"')) return this.caseSql(query, values, mode);
    throw new FakeAuthorityDatabaseError(`UNHANDLED_SQL:${query.slice(0, 80)}`);
  }

  private authorize(values: readonly unknown[]): Array<{
    tenantActive: boolean;
    projectActive: boolean;
    actorType: 'human_pm';
    actorActive: boolean;
    roleId: string | null;
    roleActive: boolean;
    permissions: string[];
    membershipActive: boolean;
  }> {
    const tenantId = String(values[0]);
    const projectId = String(values[1]);
    const actorId = String(values[2]);
    const membership = this.memberships.get(`${tenantId}:${projectId}:${actorId}`);
    if (!membership) {
      return [{
        tenantActive: false, projectActive: false, actorType: 'human_pm', actorActive: false,
        roleId: null, roleActive: false, permissions: [], membershipActive: false,
      }];
    }
    return [{
      tenantActive: true, projectActive: true, actorType: 'human_pm', actorActive: true,
      roleId: 'role', roleActive: true, permissions: [...membership.permissions], membershipActive: true,
    }];
  }

  private visible(row: { projectId?: unknown }): boolean {
    return row.projectId === this.projectId;
  }

  private caseSql(query: string, values: readonly unknown[], mode: 'execute' | 'query'): unknown {
    if (/^SELECT /u.test(query) && query.includes('"requestId"=$2') && !query.includes('"id"=$2')) {
      const projectId = String(values[0]);
      const requestId = String(values[1]);
      return [...this.cases.values()].filter((row) => row.projectId === projectId && row.requestId === requestId && this.visible(row));
    }
    if (/^SELECT /u.test(query)) {
      const projectId = String(values[0]);
      const id = String(values[1]);
      const row = this.cases.get(id);
      return row && row.projectId === projectId && this.visible(row) ? [row] : [];
    }
    if (/^INSERT /u.test(query)) {
      this.maybeFail('BlroEngineerCase', 'INSERT');
      const [id, tenantId, projectId, actorId, revision, guideRevision, guideDigest, observationDigest, requirementDigest, requestId, requestDigest, environmentKind, originalPresent, document] = values;
      if (projectId !== this.projectId) return 0;
      if (this.cases.has(String(id))) throw new FakeAuthorityDatabaseError('UNIQUE_CASE_ID');
      const row: CaseRow = {
        id, tenantId, projectId, actorId, revision, guideRevision, guideDigest,
        observationDigest, requirementDigest, requestId, requestDigest, environmentKind,
        originalPresent, document: typeof document === 'string' ? JSON.parse(document) : document,
      };
      this.cases.set(String(id), row);
      return 1;
    }
    if (/^UPDATE /u.test(query)) {
      this.maybeFail('BlroEngineerCase', 'UPDATE');
      const [actorId, revision, guideRevision, guideDigest, observationDigest, requirementDigest, requestId, requestDigest, environmentKind, originalPresent, document, projectId, id, expectedRevision] = values;
      const current = this.cases.get(String(id));
      if (!current || current.projectId !== projectId || !this.visible(current) || current.revision !== expectedRevision) return 0;
      this.cases.set(String(id), {
        ...current, actorId, revision, guideRevision, guideDigest, observationDigest,
        requirementDigest, requestId, requestDigest, environmentKind, originalPresent,
        document: typeof document === 'string' ? JSON.parse(document) : document,
      });
      return 1;
    }
    throw new FakeAuthorityDatabaseError(`UNHANDLED_CASE_SQL:${query.slice(0, 40)}`);
  }

  private artifactSql(query: string, values: readonly unknown[], mode: 'execute' | 'query'): unknown {
    if (/^DELETE /u.test(query)) {
      this.maybeFail('BlroEngineerCaseArtifact', 'DELETE');
      const projectId = String(values[0]);
      const caseId = String(values[1]);
      let count = 0;
      for (const [key, row] of [...this.artifacts.entries()]) {
        if (row.projectId === projectId && row.caseId === caseId && this.visible(row)) {
          this.artifacts.delete(key);
          count += 1;
        }
      }
      return mode === 'execute' ? count : [];
    }
    if (/^INSERT /u.test(query)) {
      this.maybeFail('BlroEngineerCaseArtifact', 'INSERT');
      const [id, tenantId, projectId, actorId, caseId, digest, mediaType, payload, sanitized, retention] = values;
      if (projectId !== this.projectId) return 0;
      this.artifacts.set(`${String(projectId)}:${String(caseId)}:${String(id)}`, {
        id, tenantId, projectId, actorId, caseId, digest, mediaType, payload, sanitized, retention,
      });
      return 1;
    }
    if (/^SELECT /u.test(query) && values.length >= 3) {
      const row = this.artifacts.get(`${String(values[0])}:${String(values[1])}:${String(values[2])}`);
      return row && this.visible(row) ? [row] : [];
    }
    if (/^SELECT /u.test(query)) {
      return [...this.artifacts.values()].filter((row) => row.projectId === values[0] && row.caseId === values[1] && this.visible(row));
    }
    throw new FakeAuthorityDatabaseError(`UNHANDLED_ARTIFACT_SQL:${query.slice(0, 40)}`);
  }

  private maybeFail(table: string, verb: 'INSERT' | 'UPDATE' | 'DELETE'): void {
    if (this.failOn && this.failOn.table === table && this.failOn.verb === verb) {
      this.failOn = undefined;
      throw new FakeAuthorityDatabaseError(`INJECTED_${verb}_FAIL`);
    }
  }
}
