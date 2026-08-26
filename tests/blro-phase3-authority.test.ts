import { describe, expect, it } from 'vitest';
import {
  IdentityScopeService,
  type IdentityDirectory,
} from '../packages/sangfor-identity/src/index.js';
import {
  filterScopedRagCandidates,
  ragSearchScopedSync,
  type RagDocumentChunk,
} from '../packages/sangfor-rag/src/index.js';
import {
  AUTHORITY_MIGRATIONS,
  BlroAuthorityStore,
  buildAuditEvent,
  verifyAuditEvents,
  type AuthorityDatabase,
  type SqlExecutor,
} from '../packages/sangfor-authority/src/index.js';

const directory: IdentityDirectory = {
  tenants: [{ id: 'tenant-a', active: true }],
  projects: [
    { id: 'project-a', tenantId: 'tenant-a', active: true },
    { id: 'project-b', tenantId: 'tenant-a', active: true },
  ],
  actors: [{ id: 'actor-a', tenantId: 'tenant-a', actorType: 'human_pm', active: true }],
  roles: [{ id: 'reader', tenantId: 'tenant-a', permissions: ['rag:read'] }],
  memberships: [{ actorId: 'actor-a', projectId: 'project-a', roleId: 'reader', active: true }],
};

const request = {
  tenantId: 'tenant-a',
  projectId: 'project-a',
  actorId: 'actor-a',
  permission: 'rag:read',
} as const;

describe('BLRO Phase 3 authority', () => {
  it('authorizes only an active tenant/project/actor/role/membership tuple', () => {
    const service = new IdentityScopeService(directory);
    expect(service.authorize(request)).toMatchObject({ ok: true, scope: request });
    expect(service.authorize({ ...request, projectId: 'project-b' })).toEqual({
      ok: false,
      reason: 'MEMBERSHIP_NOT_AUTHORIZED',
    });
    expect(service.authorize({ ...request, tenantId: '' })).toEqual({
      ok: false,
      reason: 'SCOPE_INVALID',
    });

    const foreignRoleDirectory: IdentityDirectory = {
      ...directory,
      roles: [{ id: 'reader', tenantId: 'tenant-b', permissions: ['rag:read'] }],
    };
    expect(new IdentityScopeService(foreignRoleDirectory).authorize(request)).toEqual({
      ok: false,
      reason: 'ROLE_NOT_AUTHORIZED',
    });
  });

  it('classifies every persistent product aggregate and its migration boundary', () => {
    const aggregates = new Set(AUTHORITY_MIGRATIONS.map((entry) => entry.aggregate));
    for (const required of [
      'tenant_identity', 'project_installation_identity', 'registry_services', 'runs_steps',
      'approvals_nonces', 'audit', 'evidence', 'rag_source_chunks', 'rag_embeddings_local_index', 'pm_tasks',
      'feedback_lessons', 'evals', 'wiki_proposals', 'learning_strategy_lifecycle',
      'firmware_version_evidence', 'config_chronicle_state', 'capability_evidence_promotion',
    ]) expect(aggregates.has(required)).toBe(true);
    for (const migration of AUTHORITY_MIGRATIONS) {
      expect(migration.sources.length).toBeGreaterThan(0);
      for (const source of migration.sources) {
        expect(source.path.length).toBeGreaterThan(0);
        expect(source.symbol.length).toBeGreaterThan(0);
      }
      expect(migration.secretPolicy.length).toBeGreaterThan(0);
    }
    const credentials = AUTHORITY_MIGRATIONS.find((entry) => entry.aggregate === 'browser_credentials_private_keys');
    expect(credentials).toMatchObject({ classification: 'credential_local', target: { kind: 'excluded' }, secretPolicy: 'forbid' });
  });

  it('removes out-of-project chunks before ranking sees the candidate set', () => {
    const base = {
      sourceType: 'manual' as const,
      product: 'HCI' as const,
      title: 'scope probe',
      text: 'identical ranking text',
      trustLevel: 'official' as const,
      vector: [1, 0],
      contentHash: 'hash',
      filePath: '/source',
      tenantId: 'tenant-a',
      aclActorIds: [] as string[],
    };
    const chunks: RagDocumentChunk[] = [
      { ...base, id: 'inside', projectId: 'project-a' },
      { ...base, id: 'outside', projectId: 'project-b' },
    ];
    expect(() => filterScopedRagCandidates(chunks, request as never)).toThrow('RAG_SCOPE_UNAUTHORIZED');

    const authorization = new IdentityScopeService(directory).authorize(request);
    const candidates = filterScopedRagCandidates(chunks, authorization);
    expect(candidates.map((chunk) => chunk.id)).toEqual(['inside']);

    let rankedIds: string[] = [];
    const hits = ragSearchScopedSync({
      authorization,
      query: 'identical ranking text',
      chunks,
      onCandidates: (authorized) => { rankedIds = authorized.map((chunk) => chunk.id); },
    });
    expect(rankedIds).toEqual(['inside']);
    expect(hits.map((hit) => hit.id)).toEqual(['inside']);
  });

  it('detects a rewritten entry in an append-only keyed audit chain', () => {
    const secret = 'phase3-test-secret';
    const first = buildAuditEvent({ projectId: 'project-a', seq: 0, kind: 'run.created', payload: { runId: 'r1' }, prevHash: 'GENESIS' }, secret);
    const second = buildAuditEvent({ projectId: 'project-a', seq: 1, kind: 'step.finished', payload: { verdict: 'PASS' }, prevHash: first.hash }, secret);
    expect(verifyAuditEvents([first, second], secret)).toEqual({ ok: true, keyed: true });
    expect(verifyAuditEvents([{ ...first, payload: { runId: 'rewritten' } }, second], secret)).toEqual({
      ok: false,
      keyed: true,
      brokenAt: 0,
    });
  });

  it('masks RAG provenance before the sole writer persists it', async () => {
    const calls: unknown[][] = [];
    const executor: SqlExecutor = {
      async $executeRawUnsafe(_query: string, ...values: unknown[]) {
        calls.push(values);
        return 1;
      },
      async $queryRawUnsafe<T>() {
        return [{
          tenantActive: true,
          projectActive: true,
          actorType: 'human_pm',
          actorActive: true,
          roleId: 'reader',
          roleActive: true,
          permissions: ['rag:write'],
          membershipActive: true,
        }] as T;
      },
    };
    const database: AuthorityDatabase = {
      ...executor,
      async $transaction<T>(work: (tx: SqlExecutor) => Promise<T>) {
        return work(executor);
      },
    };
    const store = new BlroAuthorityStore(database);

    await store.putRagDocument({
      id: 'document-a',
      tenantId: 'tenant-a',
      projectId: 'project-a',
      actorId: 'actor-a',
      title: 'masked provenance',
      sourceRef: 'source-a',
      contentHash: 'document-hash',
      provenance: { apiToken: 'must-not-persist', nested: { cookie: 'must-not-persist' } },
      chunks: [],
    });

    expect(JSON.parse(String(calls[1]?.at(-1)))).toEqual({
      apiToken: '***',
      nested: { cookie: '***' },
    });
  });
});
