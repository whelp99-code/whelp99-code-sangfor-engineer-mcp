/**
 * BM25 lexical scoring — the keyword half of the hybrid (BM25+cosine) ranker
 * in index.ts. Tokenizer is deliberately identical to hash-embedding.ts's so
 * "keyword match" and "hashed bag-of-words cosine" reason about the same
 * token stream; only the scoring formula differs.
 */

const TOKEN_RE = /[a-z0-9가-힣._/-]+/g;

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(TOKEN_RE) ?? [];
}

export interface Bm25Options {
  k1?: number;
  b?: number;
}

/**
 * Okapi BM25 over `docs`, scored against `query`. IDF is computed from the
 * document-frequency of each query term *within `docs`* — callers should pass
 * the already-filtered candidate set (product/version/trust-level), not the
 * whole index, so ranking reflects "rare among what could actually match"
 * rather than "rare across the entire corpus".
 */
export function computeBm25Scores(
  query: string,
  docs: readonly { id: string; text: string }[],
  options: Bm25Options = {},
): Map<string, number> {
  const k1 = options.k1 ?? 1.2;
  const b = options.b ?? 0.75;
  const scores = new Map<string, number>();
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0 || docs.length === 0) {
    for (const doc of docs) scores.set(doc.id, 0);
    return scores;
  }

  const docTermCounts = new Map<string, Map<string, number>>();
  const docLengths = new Map<string, number>();
  const termDocFrequency = new Map<string, number>();
  let totalLength = 0;

  for (const doc of docs) {
    const tokens = tokenize(doc.text);
    docLengths.set(doc.id, tokens.length);
    totalLength += tokens.length;
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    docTermCounts.set(doc.id, counts);
    for (const term of counts.keys()) termDocFrequency.set(term, (termDocFrequency.get(term) ?? 0) + 1);
  }

  const avgDocLength = totalLength / docs.length || 1;
  const docCount = docs.length;

  for (const doc of docs) {
    const counts = docTermCounts.get(doc.id)!;
    const docLength = docLengths.get(doc.id) ?? 0;
    let score = 0;
    for (const term of queryTerms) {
      const frequency = counts.get(term) ?? 0;
      if (frequency === 0) continue;
      const docFrequency = termDocFrequency.get(term) ?? 0;
      const idf = Math.log((docCount - docFrequency + 0.5) / (docFrequency + 0.5) + 1);
      const denominator = frequency + k1 * (1 - b + (b * docLength) / avgDocLength);
      score += idf * ((frequency * (k1 + 1)) / denominator);
    }
    scores.set(doc.id, score);
  }
  return scores;
}
