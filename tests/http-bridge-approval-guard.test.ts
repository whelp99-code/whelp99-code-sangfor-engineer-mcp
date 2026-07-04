import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { authorizeToolCall } from '../apps/http-bridge/src/tool-guard.js';
import { signApprovalToken, type SignedApproval } from '../packages/sangfor-operator/src/approval.js';

const toolList = {
  tools: [
    { name: 'ro', annotations: { readOnlyHint: true, destructiveHint: false } },
    { name: 'write', annotations: { readOnlyHint: false, destructiveHint: false } },
    { name: 'destructive', annotations: { readOnlyHint: false, destructiveHint: true } },
    { name: 'noannot', annotations: {} },
  ],
};

// T-BR-1: approval 미첨부 시 기존 5규칙 판정이 바이트 단위로 동일해야 한다.
describe('authorizeToolCall — 무승인 경로 회귀 고정 (T-BR-1)', () => {
  it('read-only allowed regardless of whitelist', () => {
    expect(authorizeToolCall({ name: 'ro', toolListResult: toolList, enforceWhitelist: true }).allow).toBe(true);
    expect(authorizeToolCall({ name: 'ro', toolListResult: toolList, enforceWhitelist: false }).allow).toBe(true);
  });
  it('destructive ALWAYS refused without approval', () => {
    const d = authorizeToolCall({ name: 'destructive', toolListResult: toolList, enforceWhitelist: false });
    expect(d).toEqual({ allow: false, status: 403, error: 'Destructive tool refused by MCP annotations: destructive' });
  });
  it('write refused when whitelist enforced, allowed when disabled', () => {
    expect(authorizeToolCall({ name: 'write', toolListResult: toolList, enforceWhitelist: true })).toEqual(
      { allow: false, status: 403, error: 'Tool is not annotated read-only: write' });
    expect(authorizeToolCall({ name: 'write', toolListResult: toolList, enforceWhitelist: false }).allow).toBe(true);
  });
  it('missing annotations refused (fail-closed)', () => {
    expect(authorizeToolCall({ name: 'noannot', toolListResult: toolList, enforceWhitelist: false })).toEqual(
      { allow: false, status: 403, error: 'Tool annotations unavailable; refusing call: noannot' });
  });
  it('remote-bind write refused without allowRemoteWrite (R3)', () => {
    const d = authorizeToolCall({ name: 'write', toolListResult: toolList, enforceWhitelist: false, remoteBind: true, allowRemoteWrite: false });
    expect(d.allow).toBe(false);
    expect(d.status).toBe(403);
    expect(d.error).toMatch(/remote/i);
  });
});

// ─── T-BR-2: 승인 통과 경로 ─────────────────────────────────────────────────
const SECRET = 'bridge-test-secret';
const BRIDGE_ACTION = 'bridge.tool-call';

function mint(toolName: string, opts: { secret?: string; ttlMs?: number; nonce?: string } = {}): SignedApproval {
  const base = {
    approvedBy: 'tester',
    changeTicketId: 'CHG-1',
    rollbackPlanId: 'RB-1',
    nonce: opts.nonce ?? randomBytes(8).toString('hex'),
    expiresAt: new Date(Date.now() + (opts.ttlMs ?? 60_000)).toISOString(),
  };
  return { ...base, approvalToken: signApprovalToken(opts.secret ?? SECRET, { type: BRIDGE_ACTION, target: toolName }, base) };
}

describe('authorizeToolCall — 서명 승인 통과 경로 (T-BR-2)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bridge-approval-'));
    process.env.SANGFOR_NONCE_STORE_PATH = join(dir, 'nonces.json');
  });
  afterEach(() => {
    delete process.env.SANGFOR_NONCE_STORE_PATH;
    rmSync(dir, { recursive: true, force: true });
  });

  it('valid approval allows a write tool even with the whitelist enforced', () => {
    const d = authorizeToolCall({ name: 'write', toolListResult: toolList, enforceWhitelist: true, approval: mint('write'), approvalSecret: SECRET });
    expect(d).toEqual({ allow: true });
  });

  it('valid approval allows a destructive tool', () => {
    const d = authorizeToolCall({ name: 'destructive', toolListResult: toolList, enforceWhitelist: true, approval: mint('destructive'), approvalSecret: SECRET });
    expect(d.allow).toBe(true);
  });

  it('signature minted with a different secret is refused', () => {
    const d = authorizeToolCall({ name: 'write', toolListResult: toolList, enforceWhitelist: true, approval: mint('write', { secret: 'wrong' }), approvalSecret: SECRET });
    expect(d.allow).toBe(false);
    expect(d.status).toBe(403);
    expect(d.error).toMatch(/bridge approval rejected/);
  });

  it('expired approval is refused', () => {
    const d = authorizeToolCall({ name: 'write', toolListResult: toolList, enforceWhitelist: true, approval: mint('write', { ttlMs: -1000 }), approvalSecret: SECRET });
    expect(d.allow).toBe(false);
    expect(d.error).toMatch(/expired/);
  });

  it('approval is action-bound: minted for another tool is refused', () => {
    const d = authorizeToolCall({ name: 'write', toolListResult: toolList, enforceWhitelist: true, approval: mint('destructive'), approvalSecret: SECRET });
    expect(d.allow).toBe(false);
    expect(d.error).toMatch(/signature mismatch/);
  });

  it('nonce is single-use: the second authorization with the same approval is refused', () => {
    const approval = mint('write');
    expect(authorizeToolCall({ name: 'write', toolListResult: toolList, enforceWhitelist: true, approval, approvalSecret: SECRET }).allow).toBe(true);
    const replay = authorizeToolCall({ name: 'write', toolListResult: toolList, enforceWhitelist: true, approval, approvalSecret: SECRET });
    expect(replay.allow).toBe(false);
    expect(replay.error).toMatch(/already used/);
  });

  it('missing secret fails closed even with a well-formed approval', () => {
    const d = authorizeToolCall({ name: 'write', toolListResult: toolList, enforceWhitelist: true, approval: mint('write'), approvalSecret: undefined });
    expect(d.allow).toBe(false);
    expect(d.error).toMatch(/not configured/);
  });

  it('remote-bind write is refused even with a valid approval (R3 유지)', () => {
    const d = authorizeToolCall({ name: 'write', toolListResult: toolList, enforceWhitelist: true, remoteBind: true, allowRemoteWrite: false, approval: mint('write'), approvalSecret: SECRET });
    expect(d.allow).toBe(false);
    expect(d.error).toMatch(/remote/i);
  });

  it('a refusal does NOT burn the nonce — the same approval works on loopback afterwards', () => {
    const approval = mint('write');
    const refused = authorizeToolCall({ name: 'write', toolListResult: toolList, enforceWhitelist: true, remoteBind: true, allowRemoteWrite: false, approval, approvalSecret: SECRET });
    expect(refused.allow).toBe(false);
    const allowed = authorizeToolCall({ name: 'write', toolListResult: toolList, enforceWhitelist: true, approval, approvalSecret: SECRET });
    expect(allowed.allow).toBe(true);
  });

  it('missing annotations still refuse — approval cannot bypass fail-closed', () => {
    const d = authorizeToolCall({ name: 'noannot', toolListResult: toolList, enforceWhitelist: true, approval: mint('noannot'), approvalSecret: SECRET });
    expect(d.allow).toBe(false);
    expect(d.error).toMatch(/annotations unavailable/);
  });
});
