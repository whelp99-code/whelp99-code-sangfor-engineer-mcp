import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { proposeWikiUpdate, approveWikiUpdate, mintWikiApproval } from '../packages/sangfor-wiki/src/index.js';

function propose() {
  return proposeWikiUpdate({ lessonTitle: 'Lesson', lessonBody: 'Body' });
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

  it('fails closed when no approval secret is configured', () => {
    const p = propose();
    expect(() => approveWikiUpdate(p.id, 'approved', { token: 'anything' })).toThrow(/fail-closed|not configured/i);
    expect(p.status).toBe('pending');
  });

  it('rejects a token that is not the HMAC bound to this proposal', () => {
    process.env.SANGFOR_WIKI_APPROVAL_SECRET = 'secret';
    const a = propose();
    const b = propose();
    const tokenForA = mintWikiApproval(a.id);
    expect(() => approveWikiUpdate(b.id, 'approved', { token: tokenForA })).toThrow(/HMAC|not a valid/i);
    expect(() => approveWikiUpdate(a.id, 'approved', { token: 'deadbeef' })).toThrow(/HMAC|not a valid/i);
  });

  it('approves with a proposal-bound token and records the reviewer', () => {
    process.env.SANGFOR_WIKI_APPROVAL_SECRET = 'secret';
    const p = propose();
    const result = approveWikiUpdate(p.id, 'approved', { token: mintWikiApproval(p.id), reviewer: 'cm@corp' });
    expect(result.status).toBe('approved');
    expect(result.reviewer).toBe('cm@corp');
  });

  it('allows rejection without a token (rejecting a proposal is always safe)', () => {
    const p = propose();
    const result = approveWikiUpdate(p.id, 'rejected');
    expect(result.status).toBe('rejected');
  });
});
