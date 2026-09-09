import { z } from 'zod';

const text = z.string().trim().min(1);
const sources = z.array(text).refine((values) => new Set(values).size === values.length, 'duplicate source');
const query = z.object({
  queryId: text, query: text, product: text, version: text.optional(),
  language: text.optional(), family: text.optional(), relevantSources: sources.optional(),
  hardNegativeSources: sources.optional(), forbiddenSources: sources.optional(),
});

/** Validate before search: an unlabelled positive must never disappear from the denominator. */
export const corpusEvalFixtureSchema = z.object({
  k: z.number().int().positive().max(100),
  queries: z.array(query.extend({ relevantSources: sources.refine((values) => values.length > 0, 'positive qrels required') })).min(1),
  noAnswerQueries: z.array(query),
}).superRefine((fixture, ctx) => {
  const ids = new Set<string>();
  for (const row of [...fixture.queries, ...fixture.noAnswerQueries]) {
    if (ids.has(row.queryId)) ctx.addIssue({ code: 'custom', message: `duplicate queryId: ${row.queryId}` });
    ids.add(row.queryId);
    const forbidden = new Set([...(row.hardNegativeSources ?? []), ...(row.forbiddenSources ?? [])]);
    if (row.relevantSources?.some((source) => forbidden.has(source))) {
      ctx.addIssue({ code: 'custom', message: `contradictory qrels: ${row.queryId}` });
    }
  }
  for (const row of fixture.noAnswerQueries) {
    if (row.relevantSources?.length) ctx.addIssue({ code: 'custom', message: `no-answer query has positives: ${row.queryId}` });
  }
});

export type CorpusEvalFixture = z.infer<typeof corpusEvalFixtureSchema>;
