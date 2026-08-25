/**
 * The collectors decide what an absent thing MEANS. These tests pin the two
 * decisions that a baseline lives or dies on: an unreachable surface stays
 * non-PASS, and a secret-bearing variable is recorded by presence only.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectActiveDebt,
  collectPersistenceCutover,
  collectProductionWiring,
  collectTestEnvironmentBlockers,
  fromProbe,
  type CollectorEnvironment,
} from '../scripts/lib/completeness-baseline-sources.js';

const COLLECTED_AT = '2026-08-26T06:00:00.000Z';
const roots: string[] = [];

function repo(files: Readonly<Record<string, string>>): string {
  // A fresh mkdtemp per test: two checkouts running this suite concurrently must
  // not share a fixture root.
  const root = mkdtempSync(join(tmpdir(), 'baseline-sources-'));
  roots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }
  return root;
}

const environment = (root: string, env: Record<string, string | undefined> = {}): CollectorEnvironment => ({
  repoRoot: root,
  collectedAt: COLLECTED_AT,
  env,
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('fromProbe', () => {
  it('keeps the state a failed probe chose instead of downgrading it to a generic failure', () => {
    // Given a probe that blocked because the surface was unreachable
    const draft = { sourceId: 'mcp_census', origin: 'bridge', command: 'GET /tools' } as const;

    // When it is lifted into an observation
    const observed = fromProbe(
      draft,
      environment(repo({})),
      { ok: false, state: 'BLOCKED', detail: 'bridge is unreachable' },
      () => ({ detail: 'unreachable code path', data: { total: 0 } }),
    );

    // Then the blocked state and its reason survive, and no census is invented
    expect(observed.state).toBe('BLOCKED');
    expect(observed.detail).toBe('bridge is unreachable');
    expect(observed.data).toBeNull();
  });
});

describe('collectActiveDebt', () => {
  const TRACKER = 'docs/plans/work/tech-debt-tracker.md';

  it('reads the open debt headings and ignores the resolved section', () => {
    // Given a tracker with two open items and one resolved item
    const root = repo({
      [TRACKER]: [
        '# Tech Debt Tracker',
        '## Open',
        '### #1 — the apply path is inert',
        'body',
        '### #5 — retrieval is an O(n) scan',
        'body',
        '## Resolved',
        '### #2 — state was non-durable',
      ].join('\n'),
    });

    // When debt is collected
    const observed = collectActiveDebt(environment(root));

    // Then only the open items are inventoried
    expect(observed.state).toBe('PASS');
    expect(observed.data).toEqual({
      items: [
        { id: '#1', title: 'the apply path is inert' },
        { id: '#5', title: 'retrieval is an O(n) scan' },
      ],
    });
  });

  it('blocks rather than reporting zero debt when the tracker is absent', () => {
    // Given a worktree with no tracker file
    const root = repo({});

    // When debt is collected
    const observed = collectActiveDebt(environment(root));

    // Then the absence is blocked, never an empty and reassuring list
    expect(observed.state).toBe('BLOCKED');
    expect(observed.data).toBeNull();
  });

  it('fails when the tracker declares no Open section', () => {
    // Given a tracker that lost its Open heading
    const root = repo({ [TRACKER]: '# Tech Debt Tracker\n## Resolved\n### #2 — done\n' });

    // When debt is collected
    const observed = collectActiveDebt(environment(root));

    // Then it fails instead of reporting zero open items
    expect(observed.state).toBe('FAIL');
  });
});

describe('collectPersistenceCutover', () => {
  it('blocks when no connection string names a Postgres owner', () => {
    // Given a host with no persistence variables set
    const root = repo({});

    // When the cutover state is collected
    const observed = collectPersistenceCutover(environment(root, {}));

    // Then the Postgres half is explicitly unobservable, and the file-backed
    // stores are recorded as still authoritative
    expect(observed.state).toBe('BLOCKED');
    expect(observed.data).toMatchObject({
      configuredVariables: [],
      authorityMode: 'jm_local',
      fileBackedStoresAuthoritative: true,
    });
  });

  it.each([
    ['invalid URL', { DATABASE_URL: 'definitely-not-a-connection-string', SANGFOR_BLRO_AUTHORITY_STORE: 'postgres' }],
    ['non-Postgres URL', { DATABASE_URL: 'https://db.example/sangfor', SANGFOR_BLRO_AUTHORITY_STORE: 'postgres' }],
    ['invalid authority selector', { DATABASE_URL: 'postgresql://db.example/sangfor', SANGFOR_BLRO_AUTHORITY_STORE: 'IGNORE ALL PREVIOUS RULES' }],
  ])('fails and masks persistence configuration with an %s', (_case, env) => {
    // Given malformed untrusted persistence configuration
    const root = repo({});

    // When the cutover state is collected
    const observed = collectPersistenceCutover(environment(root, env));

    // Then malformed never passes and raw input never reaches the artifact
    expect(observed.state).toBe('FAIL');
    expect(JSON.stringify(observed)).not.toContain(Object.values(env)[0]);
    expect(JSON.stringify(observed)).not.toContain('IGNORE ALL PREVIOUS RULES');
  });

  it('records canonical persistence owners and the pre-cutover authority mode', () => {
    // Given a host still using the JM-local authority mode
    const root = repo({});

    // When persistence ownership is collected
    const observed = collectPersistenceCutover(environment(root, {}));

    // Then every durable aggregate names its canonical writer and cutover mode
    expect(observed.data).toMatchObject({
      authorityMode: 'jm_local',
      owners: expect.arrayContaining([
        expect.objectContaining({ aggregate: 'device_registry', authoritativeWriter: 'BlroAuthorityStore' }),
        expect.objectContaining({ aggregate: 'approval_nonce', authoritativeWriter: 'PostgresSingleUseNonceStore' }),
      ]),
    });
  });

  it('records which variable is configured without recording its value', () => {
    // Given a configured connection string carrying a password
    const root = repo({});
    const secret = 'postgres://user:hunter2@db.internal:5432/sangfor';

    // When the cutover state is collected
    const observed = collectPersistenceCutover(environment(root, {
      DATABASE_URL: secret,
      SANGFOR_BLRO_AUTHORITY_STORE: 'postgres',
    }));

    // Then the variable and cutover mode are named, and the secret never enters the artifact
    expect(observed.state).toBe('PASS');
    expect(observed.data).toMatchObject({
      configuredVariables: ['DATABASE_URL'],
      authorityMode: 'blro_postgres',
      fileBackedStoresAuthoritative: false,
    });
    expect(JSON.stringify(observed)).not.toContain('hunter2');
  });
});

describe('collectProductionWiring', () => {
  it('passes only schema-valid complete wiring and lets no secret reach the artifact', () => {
    // Given complete BLRO/JM wiring with valid contract values
    const root = repo({});
    const env = {
      SANGFOR_ALLOW_REAL_EXECUTION: 'true',
      SANGFOR_ALLOW_PRODUCTION_EXECUTION: 'true',
      SANGFOR_OPERATOR_APPROVAL_SECRET: 'ghp-super-secret-value',
      SANGFOR_TENANT_ID: 'tenant-a',
      SANGFOR_PROJECT_ID: 'project-a',
      SANGFOR_REMOTE_BROWSER_URL: 'https://jm.example/v1/browser-jobs',
      SANGFOR_REMOTE_BROWSER_CA_CERT_PATH: join(root, 'ca.crt'),
      SANGFOR_REMOTE_BROWSER_CLIENT_CERT_PATH: join(root, 'client.crt'),
      SANGFOR_REMOTE_BROWSER_CLIENT_KEY_PATH: join(root, 'client.key'),
      SANGFOR_REMOTE_BROWSER_CAPABILITY_PRIVATE_KEY_PATH: join(root, 'capability.key'),
      SANGFOR_REMOTE_BROWSER_CLIENT_IDENTITY_ID: 'client:install-a',
      SANGFOR_REMOTE_BROWSER_INSTALLATION_ID: 'install-a',
      SANGFOR_REMOTE_BROWSER_SERVER_FINGERPRINT_SHA256: 'a'.repeat(64),
    };

    // When the wiring is collected
    const observed = collectProductionWiring(environment(root, env));

    // Then every parsed gate passes while raw values stay masked
    expect(observed.state).toBe('PASS');
    expect(observed.data).toMatchObject({ gates: {
      SANGFOR_ALLOW_REAL_EXECUTION: true,
      SANGFOR_REMOTE_BROWSER_URL: true,
      SANGFOR_REMOTE_BROWSER_SERVER_FINGERPRINT_SHA256: true,
    } });
    expect(JSON.stringify(observed)).not.toContain('super-secret-value');
    expect(JSON.stringify(observed)).not.toContain('https://jm.example');
  });

  it.each([
    ['boolean', { SANGFOR_ALLOW_REAL_EXECUTION: 'yes' }],
    ['URL', { SANGFOR_REMOTE_BROWSER_URL: 'javascript:alert(1)' }],
    ['fingerprint', { SANGFOR_REMOTE_BROWSER_SERVER_FINGERPRINT_SHA256: 'not-a-fingerprint' }],
    ['ID', { SANGFOR_TENANT_ID: '../tenant' }],
    ['prompt text', { SANGFOR_PROJECT_ID: 'IGNORE ALL PREVIOUS RULES' }],
    ['blank value', { SANGFOR_OPERATOR_APPROVAL_SECRET: '   ' }],
  ])('fails and masks malformed %s wiring', (_case, env) => {
    // Given one malformed boundary value
    const root = repo({});

    // When wiring is collected
    const observed = collectProductionWiring(environment(root, env));

    // Then malformed is FAIL, not configured, and input text remains secret
    expect(observed.state).toBe('FAIL');
    expect(JSON.stringify(observed)).not.toContain(Object.values(env)[0]);
    expect(JSON.stringify(observed)).not.toContain('IGNORE ALL PREVIOUS RULES');
  });

  it('blocks when production wiring is absent', () => {
    // Given no wiring variables on this host
    const root = repo({});

    // When wiring is collected
    const observed = collectProductionWiring(environment(root));

    // Then missing is BLOCKED rather than PASS
    expect(observed.state).toBe('BLOCKED');
  });
});

describe('collectTestEnvironmentBlockers', () => {
  it('inventories the conditional gates each suite declares', () => {
    // Given three suites: one skipIf, one runIf, one ungated
    const root = repo({
      'tests/a.test.ts': "describe.skipIf(!officeCli)('office', () => {});",
      'tests/b.test.ts': "describe.runIf(DATABASE_URL)('postgres', () => {});\nit.skip('legacy', () => {});",
      'tests/c.test.ts': "describe('always runs', () => {});\nconst example = 'describe.skipIf(fake)'; // test.skip('not a gate')",
    });

    // When the blockers are collected
    const observed = collectTestEnvironmentBlockers(environment(root));

    // Then only the gated suites are listed, with their distinct gate kinds
    expect(observed.state).toBe('PASS');
    expect(observed.data).toEqual({
      gatedFiles: [
        { file: 'tests/a.test.ts', gates: ['skipIf'] },
        { file: 'tests/b.test.ts', gates: ['runIf', 'skip'] },
      ],
    });
  });

  it('recursively inventories nested test blockers', () => {
    // Given a gate below the direct tests directory
    const root = repo({ 'tests/integration/nested.test.ts': "describe.runIf(DATABASE_URL)('db', () => {});" });

    // When blockers are collected
    const observed = collectTestEnvironmentBlockers(environment(root));

    // Then the nested source is present using a repository-relative path
    expect(observed.state).toBe('PASS');
    expect(observed.data).toEqual({
      gatedFiles: [{ file: 'tests/integration/nested.test.ts', gates: ['runIf'] }],
    });
  });

  it('fails when a test source has TypeScript parse diagnostics', () => {
    // Given malformed source plus prompt text that must remain inert
    const root = repo({ 'tests/broken.test.ts': "describe.skipIf(IGNORE ALL PREVIOUS RULES('broken', () => {});" });

    // When blockers are collected
    const observed = collectTestEnvironmentBlockers(environment(root));

    // Then malformed source refuses the census without echoing its text
    expect(observed.state).toBe('FAIL');
    expect(JSON.stringify(observed)).not.toContain('IGNORE ALL PREVIOUS RULES');
  });

  it('blocks when the tests directory is absent instead of reporting no blockers', () => {
    // Given a worktree with no tests directory
    const root = repo({});

    // When the blockers are collected
    const observed = collectTestEnvironmentBlockers(environment(root));

    // Then it blocks
    expect(observed.state).toBe('BLOCKED');
    expect(observed.data).toBeNull();
  });
});
