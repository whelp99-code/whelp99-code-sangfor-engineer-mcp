import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const authorityRoot = join(ROOT, 'packages/sangfor-authority/src');
const browserRoot = join(ROOT, 'packages/sangfor-browser-contracts/src');
const migrationPath = join(
  ROOT,
  'prisma/migrations/20260826220000_blro_remote_job_authority/migration.sql',
);

function remoteJobSources(root: string): string {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.includes('remote-job'))
    .map((entry) => readFileSync(join(root, entry.name), 'utf8'))
    .join('\n');
}

describe('remote-job authority architecture boundary', () => {
  it('keeps the L0 port SQL-free and removes every production memory fallback', () => {
    // Given the shipped browser-contract remote-job modules.
    const source = remoteJobSources(browserRoot);
    const handler = readFileSync(join(browserRoot, 'remote-handler.ts'), 'utf8');

    // When the dependency boundary is inspected.
    const forbidden = ['Prisma', '$queryRaw', '$executeRaw', 'MemoryJob', 'idempotencyStore'];

    // Then L0 contains only the pure port and the handler requires its authority.
    expect(forbidden.filter((token) => `${source}\n${handler}`.includes(token))).toEqual([]);
    expect(handler).toContain('readonly jobStore: RemoteJobStore');
    expect(handler).not.toMatch(/new Map|\?\? new/u);
  });

  it('composes one Prisma client into enrollment and remote-job authority without app SQL', () => {
    // Given the Control Tower composition root.
    const runtime = readFileSync(join(ROOT, 'apps/control-tower/src/authority-runtime.ts'), 'utf8');
    const remoteComposition = readFileSync(
      join(ROOT, 'apps/control-tower/src/authority-remote-completion.ts'), 'utf8',
    );

    // When its database construction and adapters are counted.
    const prismaClients = runtime.match(/new PrismaClient/g) ?? [];

    // Then one client is injected and no SQL crosses into the app.
    expect(prismaClients).toHaveLength(1);
    expect(remoteComposition).toContain('new PostgresRemoteJobStore');
    expect(remoteComposition).toContain('database: input.prisma');
    expect(`${runtime}\n${remoteComposition}`).not.toMatch(/\$queryRaw|\$executeRaw/u);
  });

  it('ships permanent FORCE-RLS tombstones with scoped uniqueness and no delete path', () => {
    // Given the authority migration and all L1 remote-job modules.
    const migration = readFileSync(migrationPath, 'utf8');
    const authority = remoteJobSources(authorityRoot);

    // When destructive and scope-bearing SQL is inspected.
    const tables = ['BlroRemoteJobCapabilityJti', 'BlroRemoteJob'] as const;

    // Then both tables are forced through RLS and runtime code cannot expire or delete tombstones.
    for (const table of tables) expect(migration).toContain(`'${table}'`);
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('BlroRemoteJob_scope_job_key');
    expect(migration).toContain('resultDigest');
    expect(migration).not.toContain('ON DELETE CASCADE');
    expect(authority).not.toMatch(/DELETE FROM "BlroRemoteJob|expiresAt.*DELETE/iu);
  });
});
