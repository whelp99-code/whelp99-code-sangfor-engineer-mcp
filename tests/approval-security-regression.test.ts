import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalizeApprovalPayload, FileSingleUseNonceStore } from '@sangfor/approval';
import { afterEach, describe, expect, it } from 'vitest';
import { controlTowerRequestSchemas } from '../apps/control-tower/src/request-boundaries.js';
import { parseBoundaryHttpBridgeRequestBodyV1 } from '../apps/http-bridge/src/runtime-boundaries.js';
import {
  signApprovalToken,
  verifyExecutionApproval,
  type ApprovalActionRef,
  type SignedApproval,
} from '../packages/sangfor-operator/src/approval.js';
import { consumeApprovalNonceAsync } from '../packages/sangfor-operator/src/nonce-store.js';
import { runNonceChild } from './helpers/approval-primitives-fixture.js';
import { testFileLocalWriteAuthority } from './helpers/local-write-authority.js';

const ACTION: ApprovalActionRef = { type: 'bridge.tool-call', target: 'sangfor.apply' };
const EXPIRES_AT = '2099-01-01T00:00:00.000Z';
const SECRET = 'approval-regression-secret-do-not-echo';
const roots: string[] = [];

function unsigned(overrides: Partial<Omit<SignedApproval, 'approvalToken'>> = {}): Omit<SignedApproval, 'approvalToken'> {
  return {
    approvedBy: 'operator',
    changeTicketId: 'CHG-1',
    rollbackPlanId: 'RB-1',
    nonce: 'nonce-1',
    expiresAt: EXPIRES_AT,
    authorityEpoch: 0,
    ...overrides,
  };
}

function legacyToken(approval: Omit<SignedApproval, 'approvalToken'>): string {
  const fields = [
    approval.approvedBy,
    approval.changeTicketId,
    approval.rollbackPlanId,
    approval.nonce,
    approval.expiresAt,
    String(approval.authorityEpoch),
    JSON.stringify({ target: ACTION.target, type: ACTION.type }),
  ];
  return createHmac('sha256', SECRET).update(fields.join('\n'), 'utf8').digest('hex');
}

function nonceStore(initial: unknown, epoch = 0): { readonly path: string; readonly store: FileSingleUseNonceStore } {
  const root = mkdtempSync(join(tmpdir(), 'approval-security-'));
  roots.push(root);
  const path = join(root, 'nonces.json');
  writeFileSync(path, JSON.stringify(initial));
  const authority = testFileLocalWriteAuthority('approvals_nonces', path);
  return { path, store: new FileSingleUseNonceStore(path, { ...authority, epoch }) };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('approval canonical encoding', () => {
  it('rejects a forged approval when rollback plan and nonce repartition the same legacy bytes', () => {
    // Given
    const original = unsigned({ rollbackPlanId: 'RB\nSHIFT', nonce: 'N' });
    const forged = unsigned({ rollbackPlanId: 'RB', nonce: 'SHIFT\nN' });
    const approval = { ...forged, approvalToken: legacyToken(original) };

    // When
    const verdict = verifyExecutionApproval({ action: ACTION, approval, secret: SECRET });

    // Then
    expect(verdict.ok).toBe(false);
  });

  it('accepts an unexpired control-free token minted by the legacy encoder', () => {
    // Given
    const fields = unsigned({ nonce: 'safe-in-flight' });
    const approval = { ...fields, approvalToken: legacyToken(fields) };

    // When
    const verdict = verifyExecutionApproval({ action: ACTION, approval, secret: SECRET });

    // Then
    expect(verdict).toEqual({ ok: true });
  });

  it('rejects control characters at mint, verify, and tower request boundaries', () => {
    // Given
    const fields = unsigned({ rollbackPlanId: 'RB\nSHIFT' });
    const approval = { ...fields, approvalToken: legacyToken(fields) };

    // When
    const verdict = verifyExecutionApproval({ action: ACTION, approval, secret: SECRET });
    const request = controlTowerRequestSchemas['approval-mint'].safeParse({
      actionType: ACTION.type,
      approvedBy: fields.approvedBy,
      changeTicketId: fields.changeTicketId,
      rollbackPlanId: fields.rollbackPlanId,
      authorityEpoch: 0,
    });
    const bridgeRequest = JSON.stringify({ name: 'sangfor.apply', approval });

    // Then
    expect(() => signApprovalToken(SECRET, ACTION, fields)).toThrow(/control character/iu);
    expect(verdict.ok).toBe(false);
    expect(request.success).toBe(false);
    expect(() => parseBoundaryHttpBridgeRequestBodyV1(bridgeRequest)).toThrow();
  });

  it('uses an unambiguous canonical encoding and never echoes the approval secret on refusal', () => {
    // Given
    const fields = ['approved', '한글', 'target'];
    const approval = { ...unsigned(), approvalToken: 'not-hex' };

    // When
    const verdict = verifyExecutionApproval({ action: ACTION, approval, secret: SECRET });

    // Then
    expect(canonicalizeApprovalPayload(fields)).toBe('approval-v2:["approved","한글","target"]');
    expect(JSON.stringify(verdict)).not.toContain(SECRET);
  });
});

describe('legacy file nonce migration', () => {
  it('rejects control-bearing nonces before selecting a durable store', async () => {
    // Given
    const environment = { SANGFOR_NONCE_STORE: 'unknown' };

    // When
    const result = await consumeApprovalNonceAsync(
      { nonce: 'N\nSHIFT', expiresAt: EXPIRES_AT, authorityEpoch: 0 },
      undefined,
      environment,
    );

    // Then
    expect(result).toEqual({ ok: false, reason: 'invalid nonce input' });
  });

  it('retains a consumed three-field legacy nonce as spent', async () => {
    // Given
    const { path, store } = nonceStore({ consumed: [{ nonce: 'spent', expiresAt: EXPIRES_AT, consumedAt: '2026-01-01T00:00:00.000Z' }] });

    // When
    const result = await store.consume('spent', EXPIRES_AT);

    // Then
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('already used') });
    const saved = JSON.parse(readFileSync(path, 'utf8')) as { consumed: Array<{ authorityEpoch: number }> };
    expect(saved.consumed[0]?.authorityEpoch).toBe(0);
  });

  it('migrates live three-field records to the current authority epoch without resetting them', async () => {
    // Given
    const { path, store } = nonceStore({ consumed: [{ nonce: 'spent', expiresAt: EXPIRES_AT, consumedAt: '2026-01-01T00:00:00.000Z' }] }, 7);

    // When
    const result = await store.consume('fresh', EXPIRES_AT);

    // Then
    expect(result).toEqual({ ok: true });
    const saved = JSON.parse(readFileSync(path, 'utf8')) as { consumed: Array<{ nonce: string; authorityEpoch: number }> };
    expect(saved.consumed).toEqual(expect.arrayContaining([
      expect.objectContaining({ nonce: 'spent', authorityEpoch: 7 }),
      expect.objectContaining({ nonce: 'fresh', authorityEpoch: 7 }),
    ]));
  });

  it('fails closed on ambiguous duplicate records', async () => {
    // Given
    const record = { nonce: 'duplicate', expiresAt: EXPIRES_AT, consumedAt: '2026-01-01T00:00:00.000Z', authorityEpoch: 0 };
    const { path, store } = nonceStore({ consumed: [record, record] });
    const before = readFileSync(path, 'utf8');

    // When
    const result = await store.consume('fresh', EXPIRES_AT);

    // Then
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/ambiguous/iu);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('allows exactly one of 32 concurrent processes to spend a nonce', async () => {
    // Given
    const { path } = nonceStore({ consumed: [] });
    const sourcePath = fileURLToPath(new URL('../packages/sangfor-approval/src/index.ts', import.meta.url));

    // When
    const children = await Promise.all(Array.from(
      { length: 32 },
      () => runNonceChild(path, sourcePath, 'contended'),
    ));
    const results = children.map((child) => JSON.parse(child.output) as { readonly ok: boolean });

    // Then
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(31);
  });
});
