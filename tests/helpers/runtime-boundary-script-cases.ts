import { z } from 'zod';
import {
  parseBoundaryCrawlCatalogV1,
  parseBoundaryKbSessionItemTableV1,
  parseBoundaryKbSiteMapV1,
  parseBoundarySafariItemTableV1,
} from '../../scripts/lib/kb-runtime-boundaries.js';
import { parseBoundaryRagEvalInputV1 } from '../../scripts/lib/rag-eval-runtime-boundary.js';
import { parseBoundaryStrategyCliInputV1 } from '../../scripts/lib/strategy-runtime-boundary.js';
import {
  REJECTED_RUNTIME_SECRET,
  type RuntimeBoundaryCase,
} from './runtime-boundary-case.js';

const itemRows = [{ key: 'library_token', value_hex: '4100' }];
const strategyCodec = z.object({
  strategyId: z.string().min(1).max(512),
}).strict();

export const runtimeBoundaryScriptCases: readonly RuntimeBoundaryCase[] = [
  {
    id: 'CRAWL_CATALOG', policy: 'loud_failure', schemaName: 'learning-operations.crawl-catalog.v1',
    parse: parseBoundaryCrawlCatalogV1,
    valid: [{ href: 'https://example.invalid/detail', text: 'fixture' }],
    invalid: [{ href: 'https://example.invalid/detail', text: 'fixture', token: REJECTED_RUNTIME_SECRET }],
  },
  {
    id: 'SAFARI_ITEM_TABLE', policy: 'loud_failure', schemaName: 'jm-operations.safari-item-table.v1',
    parse: parseBoundarySafariItemTableV1,
    valid: itemRows,
    invalid: [{ ...itemRows[0], token: REJECTED_RUNTIME_SECRET }],
  },
  {
    id: 'KB_SITE_MAP', policy: 'loud_failure', schemaName: 'learning-operations.kb-site-map.v1',
    parse: parseBoundaryKbSiteMapV1,
    valid: [{
      section: 'HCI', title: 'fixture', type: 'Document', updated: '2026-08-27',
      url: 'https://example.invalid/detail', product: 'HCI', articleId: 'article-1',
    }],
    invalid: [{
      section: 'HCI', title: 'fixture', type: 'Document', updated: '2026-08-27',
      url: 'https://example.invalid/detail', product: 'HCI', articleId: 'article-1',
      token: REJECTED_RUNTIME_SECRET,
    }],
  },
  {
    id: 'KB_SESSION_ITEM_TABLE', policy: 'loud_failure', schemaName: 'jm-operations.kb-session-item-table.v1',
    parse: parseBoundaryKbSessionItemTableV1,
    valid: itemRows,
    invalid: [{ ...itemRows[0], token: REJECTED_RUNTIME_SECRET }],
  },
  {
    id: 'RAG_EVAL_INPUT', policy: 'loud_failure', schemaName: 'rag-operations.eval-input.v1',
    parse: parseBoundaryRagEvalInputV1,
    valid: { qrels: [{ queryId: 'q-1', sourceId: 's-1', grade: 1 }], run: [{ queryId: 'q-1', sourceId: 's-1', rank: 1, score: 1 }] },
    invalid: { qrels: [], run: [], token: REJECTED_RUNTIME_SECRET },
  },
  {
    id: 'STRATEGY_CLI_INPUT', policy: 'loud_failure', schemaName: 'learning-operations.strategy-cli-input.v1',
    parse: (source) => parseBoundaryStrategyCliInputV1(source, strategyCodec),
    valid: { strategyId: 'strategy-1' },
    invalid: { strategyId: 'strategy-1', token: REJECTED_RUNTIME_SECRET },
  },
];
