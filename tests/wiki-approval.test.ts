import { testFileLocalWriteAuthority, testLocalWriteAuthority } from './helpers/local-write-authority.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { proposeWikiUpdate, approveWikiUpdate, mintWikiApproval } from '../packages/sangfor-wiki/src/index.js';

async function propose() {
  return await proposeWikiUpdate({ lessonTitle: 'Lesson', lessonBody: 'Body' }, testLocalWriteAuthority('wiki_proposals'));
}

describe('approveWikiUpdate — action-bound HMAC approval (redteam H3)', () => {
  const saved = { ...process.env };
  let wikiRoot: string;
  beforeEach(() => {
    wikiRoot = mkdtempSync(join(tmpdir(), 'wiki-'));
    process.env.SANGFOR_WIKI_ROOT = wikiRoot;
    delete process.env.SANGFOR_WIKI_APPROVAL_SECRET;
  });
  afterEach(() => {
    process.env = { ...saved };
    rmSync(wikiRoot, { recursive: true, force: true });
  });

  it('fails closed when no approval secret is configured', async () => {
    const p = await propose();
    await expect(async () => await approveWikiUpdate(p.id, 'approved', { token: 'anything' }, testLocalWriteAuthority('wiki_proposals'))).rejects.toThrow(/fail-closed|not configured/i);
    expect(p.status).toBe('pending');
  });

  it('rejects a token that is not the HMAC bound to this proposal', async () => {
    process.env.SANGFOR_WIKI_APPROVAL_SECRET = 'secret';
    const a = await propose();
    const b = await propose();
    const tokenForA = mintWikiApproval(a.id);
    await expect(async () => await approveWikiUpdate(b.id, 'approved', { token: tokenForA }, testLocalWriteAuthority('wiki_proposals'))).rejects.toThrow(/HMAC|not a valid/i);
    await expect(async () => await approveWikiUpdate(a.id, 'approved', { token: 'deadbeef' }, testLocalWriteAuthority('wiki_proposals'))).rejects.toThrow(/HMAC|not a valid/i);
  });

  it('approves with a proposal-bound token and records the reviewer', async () => {
    process.env.SANGFOR_WIKI_APPROVAL_SECRET = 'secret';
    const p = await propose();
    const result = await approveWikiUpdate(p.id, 'approved', { token: mintWikiApproval(p.id), reviewer: 'cm@corp' }, testLocalWriteAuthority('wiki_proposals'));
    expect(result.status).toBe('approved');
    expect(result.reviewer).toBe('cm@corp');
  });

  it('allows rejection without a token (rejecting a proposal is always safe)', async () => {
    const p = await propose();
    const result = await approveWikiUpdate(p.id, 'rejected', {}, testLocalWriteAuthority('wiki_proposals'));
    expect(result.status).toBe('rejected');
  });
});
