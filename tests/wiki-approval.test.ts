import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { proposeWikiUpdate, approveWikiUpdate } from '../packages/sangfor-wiki/src/index.js';

function propose() {
  return proposeWikiUpdate({ lessonTitle: 'Lesson', lessonBody: 'Body' });
}

describe('approveWikiUpdate — approval requires a valid token (redteam H3)', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.SANGFOR_WIKI_APPROVAL_TOKEN;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('fails closed when no approval token is configured', () => {
    const p = propose();
    expect(() => approveWikiUpdate(p.id, 'approved', { token: 'anything' })).toThrow(/token/i);
    expect(p.status).toBe('pending');
  });

  it('rejects approval carrying a wrong token', () => {
    process.env.SANGFOR_WIKI_APPROVAL_TOKEN = 'correct-token';
    const p = propose();
    expect(() => approveWikiUpdate(p.id, 'approved', { token: 'wrong' })).toThrow(/token/i);
    expect(p.status).toBe('pending');
  });

  it('approves with the correct token and records the reviewer', () => {
    process.env.SANGFOR_WIKI_APPROVAL_TOKEN = 'correct-token';
    const p = propose();
    const result = approveWikiUpdate(p.id, 'approved', { token: 'correct-token', reviewer: 'cm@corp' });
    expect(result.status).toBe('approved');
    expect(result.reviewer).toBe('cm@corp');
  });

  it('allows rejection without a token (rejecting a proposal is always safe)', () => {
    const p = propose();
    const result = approveWikiUpdate(p.id, 'rejected');
    expect(result.status).toBe('rejected');
  });
});
