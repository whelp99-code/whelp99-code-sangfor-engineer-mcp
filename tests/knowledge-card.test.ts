import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listKnowledgeCards, searchWiki, upsertKnowledgeCard } from '../packages/sangfor-wiki/src/index.js';

const dirs: string[] = [];

afterEach(() => {
  delete process.env.SANGFOR_WIKI_ROOT;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function wikiRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-card-'));
  dirs.push(dir);
  process.env.SANGFOR_WIKI_ROOT = dir;
  return dir;
}

describe('knowledge cards', () => {
  it('requires citations and participates in wiki search', () => {
    wikiRoot();
    expect(() => upsertKnowledgeCard({
      type: 'procedure',
      product: 'HCI',
      title: 'Invalid',
      prerequisites: [],
      steps: [],
      warnings: [],
      verification: [],
      rollback: [],
      citations: [],
      trustLevel: 'internal'
    })).toThrow(/citation/);

    const card = upsertKnowledgeCard({
      type: 'troubleshooting',
      product: 'HCI',
      version: '6.12',
      title: 'Storage heartbeat MTU mismatch',
      symptom: 'Storage heartbeat is unstable after cluster initialization.',
      cause: 'MTU mismatch on storage network.',
      prerequisites: ['Collect storage network MTU from every node.'],
      steps: ['Align storage MTU on every node.'],
      warnings: ['Do not initialize the cluster until MTU is consistent.'],
      verification: ['Verify heartbeat stability.'],
      rollback: ['Restore previous MTU if validation fails.'],
      citations: [{ sourceId: 'raw/hci.md', sourceRevision: 'rev-1', spanText: 'MTU consistency check', quoteHash: 'quote-1' }],
      trustLevel: 'internal'
    });

    expect(listKnowledgeCards()).toHaveLength(1);
    const hits = searchWiki({ product: 'HCI', query: 'heartbeat MTU', limit: 5 });
    expect(hits.some((hit) => hit.id === card.id)).toBe(true);
  });
});
