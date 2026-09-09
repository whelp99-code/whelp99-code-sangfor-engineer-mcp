import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { evaluateAnswerEvidence } from '../packages/sangfor-rag/src/answer-evidence-eval.js';
const body = 'Use port 162 for SNMP traps.';
const context = { schemaVersion: 1, fixtureSha256: 'fixture', indexSha256: 'index', rows: [{ queryId: 'q', product: 'HCI', version: '6.11.3', hits: [{ id: 'chunk', filePath: 'manual.md', product: 'HCI', version: '6.11.3', text: body }] }] };
const answer = () => ({ contextSha256: 'context', answers: [{ queryId: 'q', product: 'HCI', evidenceVersion: '6.11.3', status: 'answered', answer: body,
  citations: [{ sourceId: 'manual.md', chunkId: 'chunk', product: 'HCI', version: '6.11.3', quote: body, quoteStart: 0, textSha256: createHash('sha256').update(body).digest('hex') }] }] });
it('verifies captured quotations without claiming semantic accuracy', () => {
  expect(evaluateAnswerEvidence(context, answer())).toMatchObject({ citationIntegrityFailures: 0, answered: 1, semanticAccuracy: null });
});
it('refuses invented quotes and scope changes even with a valid source ID', () => {
  const a = answer(); a.answers[0].citations[0].quote = 'Disable logging.'; a.answers[0].citations[0].version = '6.2.0';
  expect(evaluateAnswerEvidence(context, a).rows[0].issues).toEqual(['CITATION_VERSION_MISMATCH', 'QUOTATION_NOT_EXACT']);
  a.answers[0].citations[0].chunkId = 'not-returned';
  expect(evaluateAnswerEvidence(context, a).rows[0].issues).toContain('CITATION_NOT_CAPTURED');
});
it('does not silently drop unanswered evaluation rows', () => {
  expect(() => evaluateAnswerEvidence(context, { contextSha256: 'context', answers: [] })).toThrow('RAG_ANSWER_EVAL_QUERY_SET');
});
