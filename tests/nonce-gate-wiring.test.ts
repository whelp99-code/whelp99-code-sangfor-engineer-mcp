import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  consumeApprovalNonce,
  consumeApprovalNonceAsync,
  resolveNonceStoreSelection,
} from '../packages/sangfor-operator/src/nonce-store.js';
import { signApprovalToken } from '../packages/sangfor-operator/src/approval.js';
import { assertRealExecutionAllowed, startOperatorSession } from '@sangfor/operator';
import { authorizeToolCall, BRIDGE_APPROVAL_ACTION_TYPE } from '../apps/http-bridge/src/tool-guard.js';

// Importing the MCP server module must NOT start the stdio loop.
process.env.MCP_NO_SERVE = '1';
const { getToolHandler } = await import('../apps/mcp-server/src/index.js');

/**
 * D5 step 1, wiring half — the execution gate consumes through ONE selected
 * single-use nonce store.
 *
 * Why this file exists: the Postgres store was built and proven in isolation
 * (tests/postgres-nonce-store.test.ts) but nothing consumed through it, so the
 * live gate still used the file store no matter what was configured. A
 * deployment that believed it had a shared, replica-safe single-use control
 * would silently have had a per-process one. These tests pin the two properties
 * that make the wiring trustworthy: selection is explicit and fail-closed, and
 * every call site lands in the SAME selected store.
 */

const future = () => new Date(Date.now() + 5 * 60_000).toISOString();
const DATABASE_URL = process.env.DATABASE_URL;

const TOOL_LIST = {
  tools: [
    { name: 'write', annotations: { readOnlyHint: false, destructiveHint: false } },
  ],
};

// A deliberately dead identity endpoint: the HCI write gate refuses on the
// replayed nonce before any network call, so this test never needs a device.
const DEAD_IDENTITY = 'http://127.0.0.1:9/openstack/identity/v2.0';
const HCI_HOST = '127.0.0.1';

/** Drive the third call site — the MCP server's HCI write gate — for real. */
async function applyCreateVolumeWith(nonce: string, expiresAt: string, secret: string) {
  const volumeName = 'wiring-probe-volume';
  const action = { type: 'hci.create-volume', target: `${HCI_HOST}:${volumeName}` } as const;
  const base = {
    approvedBy: 'tester', changeTicketId: 'CHG-1', rollbackPlanId: 'RB-1',
    nonce, expiresAt,

  authorityEpoch: 0,};
  return (await getToolHandler('sangfor_hci_apply_create_volume')!({
    name: volumeName,
    sizeGb: 1,
    clientToken: 'wiring-probe-token',
    identityBaseUrl: DEAD_IDENTITY,
    approval: { ...base, approvalToken: signApprovalToken(secret, action, base) },
  })) as { ok: boolean; mutationPerformed: boolean; error?: string };
}

let dir: string;
const OLD = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nonce-wiring-'));
  process.env.SANGFOR_NONCE_STORE_PATH = join(dir, 'nonces.json');
  delete process.env.SANGFOR_NONCE_STORE;
});

afterEach(() => {
  process.env = { ...OLD };
  rmSync(dir, { recursive: true, force: true });
});

describe('nonce store selection — explicit and fail-closed (C2)', () => {
  it('defaults to the file store when nothing is configured', async () => {
    const selection = resolveNonceStoreSelection(process.env);
    expect(selection.ok).toBe(true);
    expect(selection.ok && selection.kind).toBe('file');

    const result = await consumeApprovalNonceAsync({ nonce: 'n1', expiresAt: future() , authorityEpoch: 0});
    expect(result.ok).toBe(true);
    // Proof it really was the file store: the record is on disk.
    expect(readFileSync(process.env.SANGFOR_NONCE_STORE_PATH!, 'utf8')).toContain('n1');
  });

  it('REFUSES when postgres is selected without a connection string — never silently falls back to the file store', async () => {
    process.env.SANGFOR_NONCE_STORE = 'postgres';
    delete process.env.DATABASE_URL;
    delete process.env.SANGFOR_BLRO_DATABASE_URL;

    const selection = resolveNonceStoreSelection(process.env);
    expect(selection.ok, 'a postgres selection with no connection string must not resolve').toBe(false);

    const result = await consumeApprovalNonceAsync({ nonce: 'n-no-url', expiresAt: future() , authorityEpoch: 0});
    expect(result.ok, 'a misconfigured store must refuse, never allow').toBe(false);
    expect(result.reason ?? '').toMatch(/fail-closed/i);
    expect(result.reason ?? '').toMatch(/DATABASE_URL|connection string/i);
  });

  it('REFUSES when postgres is selected without a resolvable project scope', async () => {
    process.env.SANGFOR_NONCE_STORE = 'postgres';
    process.env.DATABASE_URL = 'postgresql://user:pw@127.0.0.1:1/db';
    delete process.env.SANGFOR_PROJECT_ID;
    delete process.env.SANGFOR_ENGAGEMENT_ID;

    const result = await consumeApprovalNonceAsync({ nonce: 'n-no-scope', expiresAt: future() , authorityEpoch: 0});
    expect(result.ok).toBe(false);
    expect(result.reason ?? '').toMatch(/fail-closed/i);
    expect(result.reason ?? '').toMatch(/scope|project/i);
  });

  it('REFUSES an unknown store kind rather than guessing one', async () => {
    process.env.SANGFOR_NONCE_STORE = 'sqlite-ish';
    const result = await consumeApprovalNonceAsync({ nonce: 'n-bogus', expiresAt: future() , authorityEpoch: 0});
    expect(result.ok).toBe(false);
    expect(result.reason ?? '').toMatch(/fail-closed/i);
  });

  it('REFUSES the explicitly selected unreachable database without ambient-environment dependence', async () => {
    const unreachable='postgresql://nobody:nobody@127.0.0.1:1/nonexistent?connect_timeout=1';
    const environment=Object.freeze({
      SANGFOR_BLRO_AUTHORITY_STORE:'postgres', SANGFOR_NONCE_STORE:'postgres',
      SANGFOR_BLRO_DATABASE_URL:unreachable, DATABASE_URL:unreachable,
      SANGFOR_PROJECT_ID:'proj-unreachable', SANGFOR_NONCE_STORE_PATH:join(dir,'must-not-exist.json'),
    });
    const selection=resolveNonceStoreSelection(environment);
    expect(selection).toMatchObject({ok:true,kind:'postgres',connectionString:unreachable,projectId:'proj-unreachable'});
    const result=await consumeApprovalNonceAsync(
      {nonce:'n-unreachable',expiresAt:future(),authorityEpoch:0},new Date(),environment,
    );
    expect(result).toMatchObject({ok:false,code:'STORE_UNAVAILABLE'});
    expect(result.reason??'').not.toMatch(/already used/i);
    expect(existsSync(environment.SANGFOR_NONCE_STORE_PATH)).toBe(false);
  });

  it('never echoes the connection password in a refusal reason', async () => {
    const secret = 'sup3rs3cretpw';
    process.env.SANGFOR_NONCE_STORE = 'postgres';
    process.env.DATABASE_URL = `postgresql://user:${secret}@127.0.0.1:1/nonexistent`;
    process.env.SANGFOR_PROJECT_ID = 'proj-a';

    const result = await consumeApprovalNonceAsync({ nonce: 'n-secret', expiresAt: future() , authorityEpoch: 0});
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('the synchronous entry point refuses under a non-file store rather than splitting the control across two stores', async () => {
    process.env.SANGFOR_NONCE_STORE = 'postgres';
    process.env.DATABASE_URL = 'postgresql://user:pw@127.0.0.1:55432/blro';
    process.env.SANGFOR_PROJECT_ID = 'proj-a';

    const result = await consumeApprovalNonce({ nonce: 'n-sync', expiresAt: future() , authorityEpoch: 0});
    expect(result.ok, 'the sync path must not consume from the file store while postgres is selected').toBe(false);
    expect(result.reason ?? '').toMatch(/fail-closed/i);
  });
});

describe('one store backs every call site (C1)', () => {
  beforeEach(() => {
    process.env.SANGFOR_ALLOW_REAL_EXECUTION = 'true';
    process.env.SANGFOR_ALLOW_PRODUCTION_EXECUTION = 'true';
    process.env.SANGFOR_OPERATOR_APPROVAL_SECRET = 'wiring-secret';
  });

  it('a nonce consumed by the operator gate is refused by the http-bridge guard', async () => {
    const nonce = `shared-${randomUUID()}`;
    const session = startOperatorSession({ mode: 'lab', product: 'HCI', targetUrl: 'https://10.80.1.9' });
    const action = { type: 'click', target: '#save', dryRun: false } as const;
    const base = {
      approvedBy: 'tester', changeTicketId: 'CHG-1', rollbackPlanId: 'RB-1',
      nonce, expiresAt: future(),

    authorityEpoch: 0,};

    await expect(assertRealExecutionAllowed(session, action, {
      ...base, approvalToken: signApprovalToken('wiring-secret', action, base),
    })).resolves.toBeUndefined();

    // The SAME nonce presented to the second, independent gate must be refused.
    const bridgeAction = { type: BRIDGE_APPROVAL_ACTION_TYPE, target: 'write' } as const;
    const decision = await authorizeToolCall({
      name: 'write',
      toolListResult: TOOL_LIST,
      enforceWhitelist: true,
      approval: { ...base, approvalToken: signApprovalToken('wiring-secret', bridgeAction, base) },
      approvalSecret: 'wiring-secret',
    });
    expect(decision.allow, 'the bridge must not re-consume a nonce the operator gate already burned').toBe(false);
    expect(decision.error ?? '').toMatch(/already used/);
  });

  it('a nonce consumed by the operator gate is refused by the MCP HCI write gate, before any device call', async () => {
    const nonce = `shared-hci-${randomUUID()}`;
    const expiresAt = future();
    const session = startOperatorSession({ mode: 'lab', product: 'HCI', targetUrl: 'https://10.80.1.9' });
    const action = { type: 'click', target: '#save', dryRun: false } as const;
    const base = {
      approvedBy: 'tester', changeTicketId: 'CHG-1', rollbackPlanId: 'RB-1',
      nonce, expiresAt,

    authorityEpoch: 0,};

    await expect(assertRealExecutionAllowed(session, action, {
      ...base, approvalToken: signApprovalToken('wiring-secret', action, base),
    })).resolves.toBeUndefined();

    const result = await applyCreateVolumeWith(nonce, expiresAt, 'wiring-secret');
    expect(result.ok, 'the HCI gate must not re-consume a nonce the operator gate already burned').toBe(false);
    expect(result.mutationPerformed).toBe(false);
    expect(result.error ?? '').toMatch(/already used/);
  });

  it('the HCI write gate consumes a fresh nonce exactly once', async () => {
    const nonce = `hci-once-${randomUUID()}`;
    const expiresAt = future();
    // The first call gets past the gate and fails at the dead device instead —
    // proof the gate allowed it — and the replay is refused by the gate itself.
    await applyCreateVolumeWith(nonce, expiresAt, 'wiring-secret');
    const replay = await applyCreateVolumeWith(nonce, expiresAt, 'wiring-secret');
    expect(replay.ok).toBe(false);
    expect(replay.error ?? '').toMatch(/already used/);
  });
});

describe.runIf(DATABASE_URL)('the selected postgres store is what the gate actually consumes (C1/C4, live database)', () => {
  const fixtureId = randomUUID();
  const tenantId = `wiring-tenant-${fixtureId}`;
  const projectId = `wiring-project-${fixtureId}`;
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL as string } } });
    await prisma.$executeRawUnsafe(
      `INSERT INTO "BlroTenant" ("id","name") VALUES ($1,$2)`,
      tenantId,
      'Nonce wiring integration test',
    );
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.project_id', $1, true)`, projectId);
      await tx.$executeRawUnsafe(
        `INSERT INTO "BlroProject" ("id","tenantId","name") VALUES ($1,$2,$3)`,
        projectId,
        tenantId,
        'Nonce wiring project',
      );
    });
  });

  afterAll(async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.project_id', $1, true)`, projectId);
      await tx.$executeRawUnsafe(`DELETE FROM "BlroApprovalNonce" WHERE "projectId"=$1`, projectId);
      await tx.$executeRawUnsafe(`DELETE FROM "BlroProject" WHERE "id"=$1`, projectId);
    });
    await prisma.$executeRawUnsafe(`DELETE FROM "BlroTenant" WHERE "id"=$1`, tenantId);
    await prisma.$disconnect();
  });

  beforeEach(() => {
    process.env.SANGFOR_NONCE_STORE = 'postgres';
    process.env.DATABASE_URL = DATABASE_URL;
    process.env.SANGFOR_PROJECT_ID = projectId;
    process.env.SANGFOR_ALLOW_REAL_EXECUTION = 'true';
    process.env.SANGFOR_ALLOW_PRODUCTION_EXECUTION = 'true';
    process.env.SANGFOR_OPERATOR_APPROVAL_SECRET = 'wiring-secret';
  });

  it('records the consumption in postgres, not in the file store', async () => {
    const nonce = `pg-${randomUUID()}`;
    const first = await consumeApprovalNonceAsync({ nonce, expiresAt: future() , authorityEpoch: 0});
    expect(first.ok).toBe(true);

    // A brand-new EMPTY file store cannot know about this nonce. If the replay
    // is still refused, the consumption really lives in the database.
    const freshDir = mkdtempSync(join(tmpdir(), 'nonce-wiring-fresh-'));
    try {
      process.env.SANGFOR_NONCE_STORE_PATH = join(freshDir, 'nonces.json');
      const replay = await consumeApprovalNonceAsync({ nonce, expiresAt: future() , authorityEpoch: 0});
      expect(replay.ok, 'a postgres-backed consumption must survive a fresh file store').toBe(false);
      expect(replay).toMatchObject({ ok: false, code: 'ALREADY_USED' });
      expect(replay.reason ?? '').toContain('approval nonce already used:');
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  it('elects exactly one winner when the wired gate is raced', async () => {
    const nonce = `pg-race-${randomUUID()}`;
    const attempts = await Promise.all(
      Array.from({ length: 8 }, async () => await consumeApprovalNonceAsync({ nonce, expiresAt: future() , authorityEpoch: 0})),
    );
    const winners = attempts.filter((r) => r.ok);
    expect(winners, `expected exactly 1 winner, got ${winners.length}`).toHaveLength(1);
  });

  it('the operator gate and the bridge guard share the postgres store', async () => {
    const nonce = `pg-shared-${randomUUID()}`;
    const session = startOperatorSession({ mode: 'lab', product: 'HCI', targetUrl: 'https://10.80.1.9' });
    const action = { type: 'click', target: '#save', dryRun: false } as const;
    const base = {
      approvedBy: 'tester', changeTicketId: 'CHG-1', rollbackPlanId: 'RB-1',
      nonce, expiresAt: future(),

    authorityEpoch: 0,};

    await expect(assertRealExecutionAllowed(session, action, {
      ...base, approvalToken: signApprovalToken('wiring-secret', action, base),
    })).resolves.toBeUndefined();

    const bridgeAction = { type: BRIDGE_APPROVAL_ACTION_TYPE, target: 'write' } as const;
    const decision = await authorizeToolCall({
      name: 'write',
      toolListResult: TOOL_LIST,
      enforceWhitelist: true,
      approval: { ...base, approvalToken: signApprovalToken('wiring-secret', bridgeAction, base) },
      approvalSecret: 'wiring-secret',
    });
    expect(decision.allow).toBe(false);
    expect(decision.error ?? '').toMatch(/already used/);
  });
});
