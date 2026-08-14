export interface RetrievalQrel {
  queryId: string;
  sourceId: string;
  grade: number;
}

export interface RetrievalRunHit {
  queryId: string;
  sourceId: string;
  rank: number;
  score: number;
}

export interface RetrievalMetrics {
  queryCount: number;
  hitRateAtK: number;
  recallAtK: number;
  mrrAtK: number;
  ndcgAtK: number;
}

function groupByQuery<T extends { queryId: string }>(items: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const existing = grouped.get(item.queryId) ?? [];
    existing.push(item);
    grouped.set(item.queryId, existing);
  }
  return grouped;
}

function dcg(grades: readonly number[]): number {
  return grades.reduce((sum, grade, index) => sum + ((2 ** grade - 1) / Math.log2(index + 2)), 0);
}

export function computeRetrievalMetrics(
  qrels: readonly RetrievalQrel[],
  runHits: readonly RetrievalRunHit[],
  k: number,
): RetrievalMetrics {
  const qrelsByQuery = groupByQuery(qrels.filter((qrel) => qrel.grade > 0));
  const hitsByQuery = groupByQuery(runHits);
  const queryIds = [...qrelsByQuery.keys()].sort();
  if (queryIds.length === 0) {
    return { queryCount: 0, hitRateAtK: 0, recallAtK: 0, mrrAtK: 0, ndcgAtK: 0 };
  }

  let hitSum = 0;
  let recallSum = 0;
  let reciprocalRankSum = 0;
  let ndcgSum = 0;

  for (const queryId of queryIds) {
    const relevant = new Map((qrelsByQuery.get(queryId) ?? []).map((qrel) => [qrel.sourceId, qrel.grade]));
    const ranked = [...(hitsByQuery.get(queryId) ?? [])]
      .sort((a, b) => a.rank - b.rank || b.score - a.score || a.sourceId.localeCompare(b.sourceId))
      .slice(0, k);
    const seen = new Set<string>();
    const retrievedGrades: number[] = [];
    let firstRelevantRank = 0;
    for (const hit of ranked) {
      if (seen.has(hit.sourceId)) continue;
      seen.add(hit.sourceId);
      const grade = relevant.get(hit.sourceId) ?? 0;
      retrievedGrades.push(grade);
      if (grade > 0 && firstRelevantRank === 0) firstRelevantRank = retrievedGrades.length;
    }
    const relevantRetrieved = retrievedGrades.filter((grade) => grade > 0).length;
    const idealGrades = [...relevant.values()].sort((a, b) => b - a).slice(0, k);
    const idealDcg = dcg(idealGrades);
    hitSum += relevantRetrieved > 0 ? 1 : 0;
    recallSum += relevant.size > 0 ? relevantRetrieved / relevant.size : 0;
    reciprocalRankSum += firstRelevantRank > 0 ? 1 / firstRelevantRank : 0;
    ndcgSum += idealDcg > 0 ? dcg(retrievedGrades.slice(0, k)) / idealDcg : 0;
  }

  return {
    queryCount: queryIds.length,
    hitRateAtK: hitSum / queryIds.length,
    recallAtK: recallSum / queryIds.length,
    mrrAtK: reciprocalRankSum / queryIds.length,
    ndcgAtK: ndcgSum / queryIds.length
  };
}
