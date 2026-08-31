import { describe, expect, it } from 'vitest';
import { SEARCH_SQL } from '../packages/sangfor-rag/src/pgvector-sql.js';

const normalizedSearchSql = SEARCH_SQL.replace(/\s+/g, ' ').trim();

describe('pgvector search SQL contract', () => {
  it('ranks final candidates at stored-vector precision while returning the raw distance', () => {
    // Given: one SQL query serving exact and HNSW search.
    const rawDistanceProjection = 'candidate."distance" FROM candidates candidate';
    const stableFinalRanking = 'ORDER BY candidate."distance"::real,c."id" LIMIT $10';

    // When: its machine-consumed projection and final ordering are inspected.
    const projectionIndex = normalizedSearchSql.indexOf(rawDistanceProjection);
    const rankingIndex = normalizedSearchSql.indexOf(stableFinalRanking);

    // Then: raw distance remains output while only final ranking is quantized.
    expect(projectionIndex).toBeGreaterThan(-1);
    expect(rankingIndex).toBeGreaterThan(projectionIndex);
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
