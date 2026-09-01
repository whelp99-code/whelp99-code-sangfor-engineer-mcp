import { describe, expect, it } from 'vitest';
import { EXACT_SEARCH_SQL, SEARCH_SQL } from '../packages/sangfor-rag/src/pgvector-sql.js';

const normalizedExactSql = EXACT_SEARCH_SQL.replace(/\s+/g, ' ').trim();
const normalizedSearchSql = SEARCH_SQL.replace(/\s+/g, ' ').trim();

describe('pgvector search SQL contract', () => {
  it('preserves raw cosine precision through final ranking', () => {
    // Given: the SQL ranking expression used for returned candidates.
    const finalRanking = normalizedExactSql.slice(normalizedExactSql.lastIndexOf('ORDER BY'));

    // When: final ordering is inspected.
    // Then: stable ids break only true SQL distance ties without quantization.
    expect(finalRanking).toBe('ORDER BY e."embedding" <=> $8::vector,c."id" LIMIT $10');
    expect(normalizedExactSql).not.toContain('::real');
  });

  it('does not truncate the exact candidate universe at one thousand rows', () => {
    // Given: exact search has a dedicated SQL statement.
    // When: its candidate bounds are inspected.
    // Then: exact semantics do not inherit the HNSW exploration cap.
    expect(normalizedExactSql).not.toContain('LIMIT 1000');
  });

  it('preserves raw distance ordering for HNSW candidate generation', () => {
    // Given: the materialized candidate query before final reranking.
    const candidateQuery = normalizedSearchSql.slice(0, normalizedSearchSql.indexOf(') SELECT'));

    // When: its index-ordering expression is inspected.
    const candidateRanking = candidateQuery.match(/ORDER BY ([^ ]+ <=> [^ ]+)/)?.[1];

    // Then: HNSW receives the native vector distance operator without a cast.
    expect(candidateRanking).toBe('e."embedding" <=> $8::vector');
  });
});
