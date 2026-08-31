import { z } from 'zod';
import { parseRuntimeJson, type RuntimeCodec } from '../../shared/src/runtime-schema.js';
import type { CollectedDocument } from './index.js';
import type {
  SiteLearningCheckpoint,
  SiteLearningDocument,
  SiteLearningReport,
} from './site-learning-crawler.js';

const idSchema = z.string().min(1).max(512);
const textSchema = z.string().max(16 * 1024 * 1024);
const timestampSchema = z.string().min(1).max(128);
const productSchema = z.enum([
  'HCI_SCP', 'HCI', 'NGFW', 'SCC', 'IAG', 'ENDPOINT_SECURE',
  'NDR', 'CYBER_COMMAND', 'HIWARE', 'OTHER',
]);
const sourceSchema = z.enum([
  'knowledge', 'community', 'knowledge_catalog', 'support_site', 'community_site',
]);

const collectedDocumentSchema: RuntimeCodec<CollectedDocument> = z.object({
  id: idSchema,
  source: sourceSchema,
  sourceUrl: z.string().max(16_384),
  product: productSchema,
  title: textSchema,
  text: textSchema,
  trustLevel: z.enum(['official', 'internal']),
  fetchedAt: timestampSchema,
}).strict();

const crawlStatsSchema = z.object({
  discovered: z.number().int().nonnegative(),
  fetched: z.number().int().nonnegative(),
  accepted: z.number().int().nonnegative(),
  rejected: z.record(z.string().min(1).max(512), z.number().int().nonnegative()),
  duplicates: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
}).strict();

const siteLearningDocumentSchema: RuntimeCodec<SiteLearningDocument> = z.object({
  id: idSchema,
  siteId: z.enum(['sangfor_support', 'sangfor_community']),
  source: z.enum(['support_site', 'community_site']),
  sourceUrl: z.string().max(16_384),
  product: productSchema,
  title: textSchema,
  text: textSchema,
  trustLevel: z.enum(['official', 'internal']),
  fetchedAt: timestampSchema,
  contentHash: z.string().min(1).max(512),
}).strict();

const limitStateSchema = z.object({
  supportLimitReached: z.boolean(),
  communityForumLimitApplied: z.boolean(),
  communityPageLimitApplied: z.boolean(),
  communityThreadLimitApplied: z.boolean(),
}).strict();

const checkpointSchema: RuntimeCodec<SiteLearningCheckpoint> = z.object({
  version: z.literal(1),
  completed: z.boolean(),
  documents: z.array(siteLearningDocumentSchema).max(100_000),
  contentHashes: z.array(z.string().min(1).max(512)).max(100_000),
  support: crawlStatsSchema,
  community: crawlStatsSchema,
  limitState: limitStateSchema,
}).strict();

const reportSchema: RuntimeCodec<SiteLearningReport> = z.object({
  startedAt: timestampSchema,
  completedAt: timestampSchema,
  sourceRoots: z.array(z.string().max(16_384)).max(10_000),
  support: crawlStatsSchema,
  community: crawlStatsSchema,
  documents: z.number().int().nonnegative(),
  frontierExhausted: z.boolean(),
  truncatedByLimit: z.array(idSchema).max(10_000),
}).strict();

export function parseBoundaryCollectorArticleDataV1(
  source: string,
): { readonly articleId?: string; readonly articleType?: number } {
  return parseRuntimeJson(source, {
    schema: z.object({
      articleId: idSchema.optional(),
      articleType: z.number().int().positive().optional(),
    }).strict(),
    schemaName: 'collector.article-data.v1',
    policy: 'deny',
  });
}

export function parseBoundaryCollectorManifestV1(source: string): CollectedDocument[] {
  return parseRuntimeJson(source, {
    schema: z.array(collectedDocumentSchema).max(100_000),
    schemaName: 'collector.manifest.v1',
    policy: 'freeze',
    uniqueIdCollectionPath: [],
  });
}

export function parseBoundaryCollectorCheckpointV1(source: string): SiteLearningCheckpoint {
  return parseRuntimeJson(source, {
    schema: checkpointSchema,
    schemaName: 'collector.site-checkpoint.v1',
    policy: 'freeze',
    expectedVersion: 1,
    uniqueIdCollectionPath: ['documents'],
  });
}

export function parseBoundaryCollectorReportV1(source: string): SiteLearningReport {
  return parseRuntimeJson(source, {
    schema: reportSchema,
    schemaName: 'collector.site-report.v1',
    policy: 'invalid_report',
  });
}
