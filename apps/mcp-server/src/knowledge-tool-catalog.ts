import { searchManuals, getManualSection } from '../../../packages/sangfor-knowledge/src/index.js';
import { searchWiki, listKnowledgeCards, upsertKnowledgeCard } from '../../../packages/sangfor-wiki/src/index.js';
import { ingestDocument, ragSearch, getRagSearchDiagnostics, omitVectorFromHit, exportRagIndexSummary } from '../../../packages/sangfor-rag/src/index.js';
import { storeHealthCheck } from '../../../packages/sangfor-store/src/index.js';
import { loadEnvFile } from '../../../packages/sangfor-collector/src/load-env.js';
import { runLearnSourcesPipeline } from '../../../packages/sangfor-collector/src/learn-pipeline.js';
import { createFineTuneDataset, validateFineTuneDataset } from '../../../packages/sangfor-finetune/src/index.js';
import type { ToolCatalogEntry } from './mcp-contracts.js';
import { mcpLocalAuthority, wikiRoot } from './authority-path-support.js';
import { PRIVACY_MODE_SCHEMA, summarizeSearchHits } from './catalog-query-support.js';
import { recordSearchGap, searchGapWeakThreshold } from './search-gap-support.js';

export const knowledgeToolCatalog: readonly ToolCatalogEntry[] = [
  ["sangfor_search_manuals", {
    description: 'Search Sangfor manual/guide chunks by product, version and query. Supports privacy_mode (summary|structured|raw).',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, version: { type: 'string' }, query: { type: 'string' }, limit: { type: 'number' }, privacy_mode: PRIVACY_MODE_SCHEMA }, required: ['product'] },
    handler: (args: { product?: string; version?: string; query?: string; limit?: number; privacy_mode?: 'summary' | 'structured' | 'raw' }) => {
      const hits = searchManuals(args);
      return args.privacy_mode === 'summary' ? summarizeSearchHits(hits) : hits;
    }
  }],
  ["sangfor_get_manual_section", {
    description: 'Get one manual section by chunk id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    handler: ({ id }) => getManualSection(id) ?? { error: `Manual section not found: ${id}` }
  }],
  ["sangfor_search_wiki", {
    description: 'Search internal wiki chunks by product, version and query. Supports privacy_mode (summary|structured|raw).',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, version: { type: 'string' }, query: { type: 'string' }, limit: { type: 'number' }, privacy_mode: PRIVACY_MODE_SCHEMA }, required: ['product'] },
    handler: (args: { product?: string; version?: string; query?: string; limit?: number; privacy_mode?: 'summary' | 'structured' | 'raw' }) => {
      const hits = searchWiki(args);
      return args.privacy_mode === 'summary' ? summarizeSearchHits(hits) : hits;
    }
  }],
  ["sangfor_list_knowledge_cards", {
    description: 'List source-cited structured knowledge cards used by the internal wiki/card retrieval layer.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => listKnowledgeCards()
  }],
  ["sangfor_upsert_knowledge_card", {
    description: 'Create or update a source-cited structured knowledge card. Requires at least one citation; does not write to devices.',
    inputSchema: { type: 'object', properties: { card: { type: 'object' } }, required: ['card'] },
    handler: ({ card }: { card: Parameters<typeof upsertKnowledgeCard>[0] }) => upsertKnowledgeCard(card, mcpLocalAuthority('wiki_proposals', wikiRoot()))
  }],
  ["sangfor_ingest_document", {
    description: 'Parse PDF/HTML/Markdown/TXT document, chunk it, create local vector index, and store searchable RAG chunks.',
    inputSchema: { type: 'object', properties: { filePath: { type: 'string' }, product: { type: 'string' }, version: { type: 'string' }, sourceType: { type: 'string' }, trustLevel: { type: 'string' }, title: { type: 'string' }, indexPath: { type: 'string' } }, required: ['filePath', 'product'] },
    handler: ingestDocument
  }],
  ["sangfor_rag_search", {
    description: 'Search real ingested local RAG index by product/version/query. Supports privacy_mode (summary|structured|raw) to limit returned detail. Hit embedding vectors are omitted by default — pass include_vectors:true to get them back.',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, version: { type: 'string' }, sourceType: { type: 'string', enum: ['manual', 'wiki', 'lesson', 'pattern'] }, trustLevel: { type: 'string', enum: ['official', 'internal', 'draft', 'needs_review', 'customer'] }, query: { type: 'string' }, limit: { type: 'number' }, indexPath: { type: 'string' }, privacy_mode: PRIVACY_MODE_SCHEMA, include_vectors: { type: 'boolean', description: 'Include each hit\'s raw embedding vector. Default false — vectors are large and rarely needed by callers.' } }, required: ['query'] },
    handler: async (args: { query: string; product?: string; version?: string; sourceType?: 'manual' | 'wiki' | 'lesson' | 'pattern'; trustLevel?: 'official' | 'internal' | 'draft' | 'needs_review' | 'customer'; limit?: number; indexPath?: string; privacy_mode?: 'summary' | 'structured' | 'raw'; include_vectors?: boolean }) => {
      if (args.sourceType !== undefined && !['manual', 'wiki', 'lesson', 'pattern'].includes(args.sourceType)) {
        throw new Error(`INVALID_SOURCE_TYPE: ${args.sourceType}`);
      }
      if (args.trustLevel !== undefined && !['official', 'internal', 'draft', 'needs_review', 'customer'].includes(args.trustLevel)) {
        throw new Error(`INVALID_TRUST_LEVEL: ${args.trustLevel}`);
      }
      const hits = await ragSearch(args);
      const diagnostics = getRagSearchDiagnostics();
      // C2 search-gap flywheel: a weak result (nothing found, or the best hit
      // barely matches) is a signal for what to ingest/author next — capture it
      // instead of silently discarding it. Never blocks or fails the search.
      const topScore = hits.length ? Math.max(...hits.map((h) => h.score ?? 0)) : undefined;
      const weakReason: 'no_hits' | 'low_score' | undefined = hits.length === 0
        ? 'no_hits'
        : (topScore !== undefined && topScore < searchGapWeakThreshold() ? 'low_score' : undefined);
      if (weakReason) {
        recordSearchGap({ query: args.query, product: args.product, version: args.version, hitCount: hits.length, topScore, reason: weakReason });
      }
      // privacy_mode=summary already returns an object ({count, hits}) — merge
      // diagnostics into it there. The default/structured/raw response is a
      // plain hits array (existing contract callers rely on); merging
      // diagnostics into it would require wrapping the array in an object and
      // is out of scope here, so degraded status stays reachable only via this
      // object-shaped response and sangfor_rag_index_summary.
      if (args.privacy_mode === 'summary') {
        const summarized = summarizeSearchHits(hits);
        return diagnostics.degraded ? { ...summarized, ...diagnostics } : summarized;
      }
      return args.include_vectors ? hits : hits.map(omitVectorFromHit);
    }
  }],
  ["sangfor_rag_index_summary", {
    description: 'Return summary of the real local RAG index.',
    inputSchema: { type: 'object', properties: { indexPath: { type: 'string' } } },
    handler: ({ indexPath }) => exportRagIndexSummary(indexPath)
  }],
  ["sangfor_store_health", {
    description: 'Check PostgreSQL persistence (Prisma) when DATABASE_URL is configured.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => storeHealthCheck()
  }],
  ["sangfor_learn_sources", {
    description: 'Collect Sangfor KB catalog, Community threads, ingest demo docs, update local RAG index and fine-tune JSONL. Uses .env / SANGFOR_ONE_ACCESS_TOKEN when present.',
    inputSchema: {
      type: 'object',
      properties: {
        communityMaxThreadsPerForum: { type: 'number', description: 'Per forum; omit for all threads on listing page' },
        knowledgeMaxArticles: { type: 'number', description: 'KB catalog cap; omit for full catalog' },
        includeDemoDocs: { type: 'boolean' },
        ragIndexPath: { type: 'string' },
        rawDir: { type: 'string' }
      }
    },
    handler: async (args: {
      communityMaxThreadsPerForum?: number;
      knowledgeMaxArticles?: number;
      includeDemoDocs?: boolean;
      ragIndexPath?: string;
      rawDir?: string;
    }) => {
      loadEnvFile('.env');
      return runLearnSourcesPipeline({
        communityMaxThreadsPerForum: args.communityMaxThreadsPerForum,
        knowledgeMaxArticles: args.knowledgeMaxArticles,
        includeDemoDocs: args.includeDemoDocs,
        ragIndexPath: args.ragIndexPath,
        rawDir: args.rawDir,
        ingestDocumentFn: ingestDocument,
        exportRagSummaryFn: exportRagIndexSummary,
        createFineTuneDatasetFn: createFineTuneDataset,
        validateFineTuneDatasetFn: validateFineTuneDataset
      });
    }
  }],
];
