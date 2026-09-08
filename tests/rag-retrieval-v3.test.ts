import { describe, expect, it } from 'vitest';
import { cleanRetrievalText, documentVersionFromTitle, selectRetrievalSnippet } from '../packages/sangfor-rag/src/retrieval-text.js';
import { hasRetrievalEvidence, reciprocalRanks } from '../packages/sangfor-rag/src/rag-ranking.js';
import { computeBm25Scores } from '../packages/sangfor-rag/src/bm25.js';

describe('retrieval input quality', () => {
  const navigation = 'Community Partner e-Learning Official Site Partner One English Sangfor Support Home Products Troubleshooting Cases Best Practices Software Download Service Hub Log in My Sangfor';
  it('removes crawler metadata and exact navigation without discarding same-line instructions', () => {
    const text = `---\nsourceUrl: https://example.com/doc\ncontentHash: ${'a'.repeat(64)}\n---\n\n${navigation} Set mtu to 1500.\n| port | vlan |\n| eth0 | 10 |`;
    expect(cleanRetrievalText(text)).toBe('Set mtu to 1500.\n| port | vlan |\n| eth0 | 10 |');
  });
  it('preserves ordinary YAML, fenced code, and ordinary navigation words in prose', () => {
    const text = `---\nmtu: 1500\n---\n\n\`\`\`text\n${navigation}\n\`\`\`\nProducts are configured in the Home menu.`;
    expect(cleanRetrievalText(text)).toBe(text);
  });
  it('only extracts a single explicit heading release, retaining release suffixes', () => {
    expect(documentVersionFromTitle('HCI 6.11.1R1 - User Manual / Storage')).toBe('6.11.1R1');
    expect(documentVersionFromTitle('HCI 6.11.3 migration to 7.0.0')).toBeUndefined();
    expect(documentVersionFromTitle('Other 10.6.11.3 - Guide')).toBeUndefined();
    expect(documentVersionFromTitle('HCI 6.11.3 - Guide / HCI 7.0.0 - Guide')).toBeUndefined();
  });
  it('gives a reranker a relevant contiguous passage beyond a boilerplate introduction', () => {
    const text = 'General product introduction. '.repeat(80) + '\nTo repair quorum, check heartbeat packets on eth1.\n' + 'Further discussion. '.repeat(80);
    const snippet = selectRetrievalSnippet('repair quorum heartbeat', text, 400);
    expect(snippet).toContain('To repair quorum');
    expect(snippet.length).toBeLessThanOrEqual(400);
    expect(text).toContain(snippet);
  });
  it('does not mistake hash collisions or zero lexical scores for semantic evidence', () => {
    expect(hasRetrievalEvidence({ keywordScore: 0, cosineScore: 0.9, retrievalMode: 'hybrid-hash' })).toBe(false);
    expect(hasRetrievalEvidence({ keywordScore: 0, cosineScore: 0.9, retrievalMode: 'hybrid-semantic' })).toBe(true);
    expect(hasRetrievalEvidence({ keywordScore: 3, cosineScore: 0, retrievalMode: 'bm25' })).toBe(true);
  });
  it('RRF cannot rank absent or negative evidence', () => {
    expect(reciprocalRanks([0, 3, -1, 5])).toEqual([0, 1 / 62, 0, 1 / 61]);
  });
  it('invalidates cached term counts on mutation and computes IDF within the current filtered set', () => {
    const doc = { id: 'a', text: 'quorum' };
    expect(computeBm25Scores('quorum', [doc]).get('a')).toBeGreaterThan(0);
    doc.text = 'storage';
    expect(computeBm25Scores('quorum', [doc]).get('a')).toBe(0);
    doc.text = 'quorum';
    const small = computeBm25Scores('quorum', [doc]).get('a')!;
    expect(computeBm25Scores('quorum', [doc, { id: 'b', text: 'storage' }]).get('a')).toBeGreaterThan(small);
  });
});

// CLI integration: the transformation must not authorize vector reuse or alter source bytes.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
it('prepares a new candidate with explicit versions and invalidates changed vectors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rag-v3-'));
  try {
    const source = join(dir, 'source.json');
    const output = join(dir, 'candidate.json');
    const chunk = { id: 'a', filePath: 'manual.md', product: 'HCI', sourceType: 'manual', trustLevel: 'official',
      title: 'HCI 6.11.3 - Manual / Storage', text: `---\nsourceUrl: https://example.com/doc\ncontentHash: ${'a'.repeat(64)}\n---\nStorage procedure`,
      vector: [1, 0], contentHash: 'old', section: 'storage' };
    const bytes = JSON.stringify({ version: 1, updatedAt: new Date(0).toISOString(), chunks: [chunk] });
    writeFileSync(source, bytes);
    const result = JSON.parse(execFileSync('pnpm', ['--silent', 'run', 'rag:prepare:candidate', source, output], {
      encoding: 'utf8', env: { ...process.env, SANGFOR_BLRO_AUTHORITY_STORE: '' },
    }));
    expect(result).toMatchObject({ cleaned: 1, versionsAdded: 1, invalidatedVectors: 1, promotionAuthorized: false });
    expect(readFileSync(source, 'utf8')).toBe(bytes);
    const stored = JSON.parse(readFileSync(output, 'utf8')).chunks[0];
    expect(stored).toMatchObject({ version: '6.11.3', text: 'Storage procedure', vectorB64: '' });
    expect(stored.embeddingSpace).toBeUndefined();
    expect(() => execFileSync('pnpm', ['--silent', 'run', 'rag:prepare:candidate', source, output], { stdio: 'pipe' })).toThrow();
    expect(() => execFileSync('pnpm', ['--silent', 'run', 'rag:prepare:candidate', source, join(dir, 'blocked.json')], {
      stdio: 'pipe', env: { ...process.env, SANGFOR_BLRO_AUTHORITY_STORE: 'postgres' },
    })).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
