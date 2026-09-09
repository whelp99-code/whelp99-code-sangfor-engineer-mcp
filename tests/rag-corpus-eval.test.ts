import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { corpusEvalFixtureSchema } from '../packages/sangfor-rag/src/corpus-eval-contract.js';

const positive = { queryId: 'positive', query: 'heartbeat', product: 'HCI', relevantSources: ['a.md'] };
describe('frozen corpus evaluation', () => {
  it.each([
    { queries: [{ ...positive, relevantSources: [] }], noAnswerQueries: [] },
    { queries: [positive, positive], noAnswerQueries: [] },
    { queries: [positive], noAnswerQueries: [{ ...positive, relevantSources: undefined }] },
    { queries: [positive], noAnswerQueries: [{ ...positive, queryId: 'negative' }] },
    { queries: [{ ...positive, forbiddenSources: ['a.md'] }], noAnswerQueries: [] },
    { queries: [{ ...positive, relevantSources: ['a.md', 'a.md'] }], noAnswerQueries: [] },
  ])('rejects missing, duplicate or contradictory labels before execution', (fixture) => {
    expect(() => corpusEvalFixtureSchema.parse({ k: 5, ...fixture })).toThrow();
  });
  it('reports forbidden hits, missing sources, subgroup denominators and provenance without claiming promotion', () => {
    const dir = mkdtempSync(join(tmpdir(), 'corpus-contract-'));
    try {
      const indexPath = join(dir, 'index.json');
      const fixturePath = join(dir, 'qrels.json');
      writeFileSync(indexPath, JSON.stringify({ version: 1, updatedAt: new Date(0).toISOString(), chunks: [{
        id: 'a', title: 'heartbeat', section: 'network', text: 'heartbeat configuration', product: 'HCI',
        sourceType: 'manual', trustLevel: 'official', contentHash: 'a', filePath: 'a.md', vector: [],
      }] }));
      writeFileSync(fixturePath, JSON.stringify({ k: 5, queries: [positive,
        { ...positive, queryId: 'missing', language: 'ko', relevantSources: ['missing.md'] }],
      noAnswerQueries: [{ queryId: 'negative', query: 'heartbeat', product: 'HCI', forbiddenSources: ['a.md'] }] }));
      const report = JSON.parse(execFileSync('pnpm', ['--silent', 'run', 'rag:eval:corpus', indexPath, fixturePath], {
        encoding: 'utf8', env: { ...process.env, SANGFOR_BLRO_AUTHORITY_STORE: '', SANGFOR_ALLOW_CLOUD_RAG_CUSTOMER: '0' },
      }));
      expect(report.schemaVersion).toBe(2);
      expect(report.metrics.queryCount).toBe(2);
      expect(report.metrics.hitRateAtK).toBe(0.5);
      expect(report.forbiddenHits).toBe(1);
      expect(report.noAnswerFalsePositiveRate).toBe(1);
      expect(report.missingRelevantSources).toEqual(['missing.md']);
      expect(report.byLanguage.ko.queryCount).toBe(1);
      expect(report.byProduct.HCI.queryCount).toBe(2);
      expect(report.promotionStatus).toBe('NOT_EVALUATED');
      expect(report.implementationSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(report.settingsSha256).toMatch(/^[a-f0-9]{64}$/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
