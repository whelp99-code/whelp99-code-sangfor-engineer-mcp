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
import { authorizeToolCall, BRIDGE_APPROVAL_ACTION_TYPE } from '../packages/sangfor-operator/src/tool-authorization.js';

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

describe('nonce gate PostgreSQL wiring fixture', () => {
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nonce-wiring-'));
  process.env.SANGFOR_NONCE_STORE_PATH = join(dir, 'nonces.json');
  delete process.env.SANGFOR_NONCE_STORE;
});

afterEach(() => {
  process.env = { ...OLD };
  rmSync(dir, { recursive: true, force: true });
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
});
