import { z } from 'zod';
import type { NamedRuntimeCodec } from '../../shared/src/runtime-schema.js';
import type { KnowledgeCard, WikiUpdateProposal } from './wiki-types.js';

const idSchema = z.string().min(1).max(512);
const textSchema = z.string().max(16 * 1024 * 1024);
const productSchema = z.enum([
  'HCI_SCP', 'HCI', 'NGFW', 'SCC', 'IAG', 'ENDPOINT_SECURE',
  'NDR', 'CYBER_COMMAND', 'HIWARE', 'OTHER',
]);
const textListSchema = z.array(textSchema).max(100_000);
const citationSchema = z.object({
  sourceId: idSchema,
  sourceRevision: idSchema.optional(),
  headingPath: z.array(textSchema).max(1_000).optional(),
  spanText: textSchema,
  quoteHash: z.string().min(1).max(512),
}).strict();

export const wikiProposalCodec: NamedRuntimeCodec<WikiUpdateProposal> = {
  schema: z.object({
    id: idSchema,
    targetPage: z.string().min(1).max(16_384),
    title: textSchema,
    beforeText: textSchema,
    afterText: textSchema,
    status: z.enum(['pending', 'approved', 'rejected', 'applied']),
    adapter: z.enum(['memory', 'obsidian', 'github_wiki']).optional(),
    reviewer: idSchema.optional(),
  }).strict(),
  schemaName: 'wiki.proposal.v1',
};

export const knowledgeCardCodec: NamedRuntimeCodec<KnowledgeCard> = {
  schema: z.object({
    id: idSchema,
    type: z.enum(['procedure', 'troubleshooting', 'known_issue', 'config_recipe', 'compatibility_note']),
    product: productSchema,
    version: z.string().max(256).optional(),
    title: textSchema,
    symptom: textSchema.optional(),
    cause: textSchema.optional(),
    prerequisites: textListSchema,
    steps: textListSchema,
    warnings: textListSchema,
    verification: textListSchema,
    rollback: textListSchema,
    citations: z.array(citationSchema).max(100_000),
    trustLevel: z.enum(['official', 'internal', 'draft', 'needs_review', 'customer']),
    updatedAt: z.string().min(1).max(128),
  }).strict(),
  schemaName: 'wiki.knowledge-card.v1',
};
