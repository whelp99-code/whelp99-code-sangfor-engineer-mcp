import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localRerankConfigurationDigest } from '../packages/sangfor-rag/src/local-rerank-provider.js';

describe('corpus evaluation scoring provenance', () => {
  it('distinguishes configured instructions, context and candidate budgets without exposing instruction text', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rerank-provenance-'));
    try {
      const indexPath = join(dir, 'index.json'), fixturePath = join(dir, 'qrels.json');
      // One candidate deliberately needs no reranking. This checks report identity,
      // not real model inference or answer accuracy, and makes no network request.
      writeFileSync(indexPath, JSON.stringify({ version: 1, updatedAt: new Date(0).toISOString(), chunks: [{
        id: 'a', title: 'heartbeat', section: 'network', text: 'heartbeat configuration', product: 'HCI',
        sourceType: 'manual', trustLevel: 'official', contentHash: 'a', filePath: 'a.md', vector: [],
      }] }));
      writeFileSync(fixturePath, JSON.stringify({ k: 5,
        queries: [{ queryId: 'positive', query: 'heartbeat', product: 'HCI', relevantSources: ['a.md'] }],
        noAnswerQueries: [{ queryId: 'negative', query: 'unrelatedsubject', product: 'HCI' }],
      }));
      const revision = 'a'.repeat(40), instruction = 'Private evaluation wording';
      const run = (overrides: Record<string, string> = {}) => JSON.parse(execFileSync('pnpm',
        ['--silent', 'run', 'rag:eval:corpus', indexPath, fixturePath], {
          encoding: 'utf8', env: { ...process.env, SANGFOR_BLRO_AUTHORITY_STORE: '',
            SANGFOR_EMBEDDING_FORCE_HASH: '1', SANGFOR_RAG_EVAL_ASYNC: '1', SANGFOR_RAG_HYBRID_ALPHA: '0',
            SANGFOR_MIMO_RERANK_ENABLED: '0', SANGFOR_LOCAL_RERANK_ENABLED: '1',
            SANGFOR_LOCAL_RERANK_URL: 'http://127.0.0.1:1',
            SANGFOR_LOCAL_RERANK_MODEL: 'expected', SANGFOR_LOCAL_RERANK_REVISION: revision,
            SANGFOR_LOCAL_RERANK_MAX_LENGTH: '512', SANGFOR_LOCAL_RERANK_DTYPE: 'float32',
            SANGFOR_LOCAL_RERANK_BATCH_SIZE: '4', SANGFOR_LOCAL_RERANK_INSTRUCTION: instruction,
            SANGFOR_MIMO_RERANK_CANDIDATES: '40', SANGFOR_MIMO_RERANK_TIMEOUT_MS: '5000', ...overrides,
          },
        }));
      const baseline = run();
      expect(baseline.settings.localRerankerConfigurationSha256).toBe(localRerankConfigurationDigest('expected', revision,
        { maxLength: 512, dtype: 'float32', batchSize: 4, instruction }));
      expect(JSON.stringify(baseline)).not.toContain(instruction);
      const overrides: Array<Record<string, string>> = [
        { SANGFOR_LOCAL_RERANK_INSTRUCTION: 'Different evaluation wording' },
        { SANGFOR_LOCAL_RERANK_MAX_LENGTH: '1024' },
        { SANGFOR_MIMO_RERANK_CANDIDATES: '20' },
        { SANGFOR_MIMO_RERANK_TIMEOUT_MS: '60000' },
      ];
      for (const override of overrides) {
        const changed = run(override);
        expect(changed.settingsSha256).not.toBe(baseline.settingsSha256);
        expect(changed.qrelsSha256).toBe(baseline.qrelsSha256);
        expect(changed.promotionStatus).toBe('NOT_EVALUATED');
      }
      // An empty index avoids inference while proving the configured floor is
      // part of report identity. Missing gold sources remain reported failures.
      writeFileSync(indexPath, JSON.stringify({ version: 1, updatedAt: new Date(0).toISOString(), chunks: [] }));
      const noFloor = run();
      const withFloor = run({ SANGFOR_LOCAL_RERANK_MIN_SCORE: '4' });
      expect(withFloor.settings.localRerankerMinimumScore).toBe(4);
      expect(withFloor.settingsSha256).not.toBe(noFloor.settingsSha256);
      expect(withFloor.missingRelevantSources).toEqual(['a.md']);
      expect(withFloor.promotionStatus).toBe('NOT_EVALUATED');
      const combined = run({ SANGFOR_LOCAL_RERANK_MIN_SCORE: '4', SANGFOR_LOCAL_RERANK_SCORE_ORDER: 'rrf' });
      expect(combined.settings.localRerankerScoreOrder).toBe('rrf');
      expect(combined.settingsSha256).not.toBe(withFloor.settingsSha256);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 15000);
});
