import { createHash } from 'node:crypto';
import { z } from 'zod';
const text = z.string().min(1);
const passage = z.object({ id: text, filePath: text, product: text, version: text.optional(), text });
export const capturedEvidenceSchema = z.object({
  schemaVersion: z.literal(1), fixtureSha256: text, indexSha256: text,
  rows: z.array(z.object({ queryId: text, product: text, version: text.optional(), hits: z.array(passage.extend({ contextChunks: z.array(passage).optional() })) })),
});
export const clientAnswersSchema = z.object({ contextSha256: text, answers: z.array(z.object({
  queryId: text, product: text, evidenceVersion: text.optional(), status: z.enum(['answered', 'partial', 'abstained']), answer: text,
  citations: z.array(z.object({ sourceId: text, chunkId: text, product: text, version: text.optional(), quote: text,
    quoteStart: z.number().int().nonnegative(), textSha256: text })),
})) });

/** Checks provenance and scope. Semantic correctness remains an explicit separate review. */
export function evaluateAnswerEvidence(contextInput: unknown, answersInput: unknown) {
  const context = capturedEvidenceSchema.parse(contextInput), answers = clientAnswersSchema.parse(answersInput);
  const contexts = new Map(context.rows.map((row) => [row.queryId, row]));
  if (contexts.size !== context.rows.length || new Set(answers.answers.map((row) => row.queryId)).size !== answers.answers.length
    || answers.answers.length !== contexts.size) throw new Error('RAG_ANSWER_EVAL_QUERY_SET');
  const rows = answers.answers.map((answer) => {
    const row = contexts.get(answer.queryId);
    if (!row) throw new Error('RAG_ANSWER_EVAL_QUERY_SET');
    const issues: string[] = [];
    if (answer.product !== row.product) issues.push('ANSWER_PRODUCT_MISMATCH');
    if (answer.status === 'abstained' && answer.citations.length) issues.push('ABSTENTION_HAS_CITATIONS');
    if (answer.status !== 'abstained' && !answer.citations.length) issues.push('ANSWER_HAS_NO_CITATIONS');
    const available = row.hits.flatMap((hit) => [hit, ...(hit.contextChunks ?? [])]);
    for (const citation of answer.citations) {
      const source = available.find((hit) => hit.id === citation.chunkId && hit.filePath === citation.sourceId);
      if (!source) { issues.push('CITATION_NOT_CAPTURED'); continue; }
      if (source.product !== row.product || citation.product !== source.product) issues.push('CITATION_PRODUCT_MISMATCH');
      if (source.version !== citation.version || (row.version && source.version !== row.version)
        || answer.evidenceVersion !== source.version) issues.push('CITATION_VERSION_MISMATCH');
      if (createHash('sha256').update(source.text).digest('hex') !== citation.textSha256) issues.push('CITATION_TEXT_HASH_MISMATCH');
      if (source.text.slice(citation.quoteStart, citation.quoteStart + citation.quote.length) !== citation.quote) issues.push('QUOTATION_NOT_EXACT');
    }
    return { queryId: answer.queryId, status: answer.status, citationCount: answer.citations.length,
      citationIntegrityPass: issues.length === 0, issues: [...new Set(issues)] };
  });
  return { queryCount: rows.length, citationIntegrityFailures: rows.filter((row) => !row.citationIntegrityPass).length,
    answered: rows.filter((row) => row.status === 'answered').length, partial: rows.filter((row) => row.status === 'partial').length,
    abstained: rows.filter((row) => row.status === 'abstained').length, semanticAccuracy: null,
    limitation: 'Exact captured quotations and product/version integrity do not prove that every answer claim follows from those quotations. Independent semantic review is still required.', rows };
}
