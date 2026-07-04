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
