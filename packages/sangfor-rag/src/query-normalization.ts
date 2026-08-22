const BILINGUAL_DOMAIN_TERMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/제한\s*대역폭\s*채널/iu, 'limited bandwidth channel'],
  [/보장\s*대역폭\s*채널/iu, 'guaranteed bandwidth channel'],
  [/예약\s*백업(?:\s*정책|\s*작업)?/iu, 'scheduled backup policy'],
  [/분산\s*방화벽/iu, 'distributed firewall'],
  [/환경\s*요구사항/iu, 'environment requirements'],
  [/자동\s*격리/iu, 'automatic isolation'],
  [/가상\s*iSCSI/iu, 'virtual iSCSI'],
  [/상태를?\s*확인/iu, 'status check']
];

/**
 * Preserve the user's original query and append stable English product terms
 * when the corpus's authoritative manuals are English-only. This is lexical
 * expansion, not translation or answer generation: it cannot invent a source.
 */
export function normalizeRetrievalQuery(query: string): string {
  const expansions = BILINGUAL_DOMAIN_TERMS
    .filter(([pattern]) => pattern.test(query))
    .map(([, expansion]) => expansion);
  return expansions.length > 0 ? `${query} ${[...new Set(expansions)].join(' ')}` : query;
}
