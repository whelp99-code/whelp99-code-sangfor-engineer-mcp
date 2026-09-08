import { paginate } from '../../../packages/shared/src/index.js';

export const PRIVACY_MODE_SCHEMA = {
  type: 'string',
  enum: ['summary', 'structured', 'raw'],
  description: 'Privacy/verbosity mode: summary (concise), structured (default object), raw (full detail). Honored by read tools to limit returned detail.',
};

// Honor privacy_mode=summary on search tools: return only id/title/score instead
// of full chunk bodies, so agents can request less detail. structured/raw return
// the full result unchanged.
export function summarizeSearchHits(hits: Array<{ id: string; title: string; score?: number }>) {
  return { count: hits.length, hits: hits.map((h) => ({ id: h.id, title: h.title, score: h.score })) };
}

// Opt-in cursor pagination for a handful of list tools that historically returned
// their whole array. Backward-compat contract: when the caller passes neither
// cursor nor limit, return the field unchanged (full array, no nextCursor) — the
// same shape those tools have always returned. Only pass cursor/limit to switch
// into a paginated `{ [fieldName]: page, nextCursor? }` response.
export function paginateOptionalField<T>(
  allItems: T[],
  args: { cursor?: string; limit?: number },
  getKey: (item: T) => string,
  fieldName: string,
): Record<string, unknown> {
  if (args.cursor === undefined && args.limit === undefined) return { [fieldName]: allItems };
  const { items, nextCursor } = paginate(allItems, { cursor: args.cursor, limit: args.limit, getKey });
  return { [fieldName]: items, ...(nextCursor === undefined ? {} : { nextCursor }) };
}
