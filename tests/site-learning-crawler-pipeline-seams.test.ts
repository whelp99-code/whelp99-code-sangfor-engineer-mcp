import { describe, expect, it } from 'vitest';
import { buildFineTuneExample } from '../packages/sangfor-finetune/src/index.js';
import { ingestDocumentsBatch } from '../packages/sangfor-rag/src/index.js';
import { inferLearningProduct } from '../packages/sangfor-collector/src/site-learning-crawler.js';

describe('two-site learning crawler learned-document pipeline seams', () => {
  it('keeps supported products explicit and unsupported products out of HCI', () => {
    expect(inferLearningProduct('Hyper Converged Infrastructure HCI deployment')).toBe('HCI');
    expect(inferLearningProduct('Athena NGFW firewall policy guide')).toBe('NGFW');
    expect(inferLearningProduct('aDesk Virtual Desktop Infrastructure')).toBe('OTHER');
    expect(inferLearningProduct('HCI, IAG, and Endpoint Secure product catalog')).toBe('OTHER');
  });

  it('preserves each learned document product in fine-tuning metadata', () => {
    expect(buildFineTuneExample({
      product: 'OTHER',
      taskType: 'lesson_extraction',
      userInput: 'Athena NGFW case',
      expectedOutput: 'Use the official source.',
      source: 'https://support.sangfor.com/cases/list'
    }).product).toBe('OTHER');
  });

  it('exposes a batch RAG ingest path for full-site learning', () => {
    expect(typeof ingestDocumentsBatch).toBe('function');
  });
});
