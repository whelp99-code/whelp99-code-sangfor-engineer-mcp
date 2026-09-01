import { z } from 'zod';
import {
  parseBoundaryLoopCursorsV1,
  parseBoundaryLoopEmbeddingIndexV1,
  parseBoundaryLoopGapEventV1,
  parseBoundaryLoopGapQueriesV1,
  parseBoundaryLoopGraphV1,
  parseBoundaryLoopLearnQueueV1,
  parseBoundaryLoopLedgerLineV1,
} from '../../packages/sangfor-loop/src/runtime-boundaries.js';
import {
  parseBoundaryRagIndexV1,
  parseBoundaryRagRerankResponseV1,
  parseBoundaryRagShardLineV1,
  parseBoundaryRagShardManifestV1,
} from '../../packages/sangfor-rag/src/runtime-boundaries.js';
import { parseBoundaryRunRecordLineV1 } from '../../packages/sangfor-runs/src/runtime-boundaries.js';
import {
  parseBoundaryMaturityPolicyV1,
  parseBoundarySafetyPolicyV1,
} from '../../packages/sangfor-safety/src/runtime-boundaries.js';
import {
  parseBoundaryShadowLedgerLineV1,
  parseBoundaryTimeSavedLineV1,
  shadowRunCodec,
} from '../../packages/sangfor-scorecard/src/runtime-boundaries.js';
import { parseBoundaryIntendedSpecV1 } from '../../packages/sangfor-spec/src/runtime-boundaries.js';
import { parseBoundarySharedJsonlRecordV1 } from '../../packages/shared/src/runtime-schema.js';
import {
  REJECTED_RUNTIME_SECRET,
  type RuntimeBoundaryCase,
} from './runtime-boundary-case.js';

const ragChunk = {
  id: 'chunk-1', sourceType: 'manual', product: 'HCI', title: 'title', text: 'text',
  trustLevel: 'official', vector: [0.1], contentHash: 'hash-1', filePath: 'fixture.md',
};
const gapEvent = {
  id: 'gap-1', ts: '2026-08-27T00:00:00.000Z', query: 'HCI',
  hitCount: 0, reason: 'no_hits',
};
const loopLedger = {
  id: 'loop-1', ts: '2026-08-27T00:00:00.000Z', tick: 'tick-1',
  edge: 'edge-1', node: 'node-1', outcome: 'executed',
};
const simpleCodec = {
  schema: z.object({ id: z.string().min(1).max(512), value: z.string().max(100) }).strict(),
  schemaName: 'test.shared-record.v1',
};

export const runtimeBoundaryDomainBCases: readonly RuntimeBoundaryCase[] = [
  {
    id: 'LOOP_EMBEDDING_INDEX', policy: 'freeze', schemaName: 'loop.embedding-index.v1',
    parse: parseBoundaryLoopEmbeddingIndexV1,
    valid: { version: 2, updatedAt: '2026-08-27T00:00:00.000Z', chunks: [ragChunk] },
    invalid: { version: 2, updatedAt: '2026-08-27T00:00:00.000Z', chunks: [{ ...ragChunk, token: REJECTED_RUNTIME_SECRET }] },
  },
  {
    id: 'LOOP_GAP_QUERIES', policy: 'freeze', schemaName: 'loop.gap-queries.v1',
    parse: parseBoundaryLoopGapQueriesV1,
    valid: { version: 1, updatedAt: '2026-08-27T00:00:00.000Z', queries: [] },
    invalid: { version: 1, updatedAt: '2026-08-27T00:00:00.000Z', queries: [], token: REJECTED_RUNTIME_SECRET },
  },
  {
    id: 'LOOP_GAP_EVENT', policy: 'freeze', schemaName: 'loop.gap-event.v1',
    parse: parseBoundaryLoopGapEventV1,
    valid: gapEvent, invalid: { ...gapEvent, token: REJECTED_RUNTIME_SECRET },
  },
  {
    id: 'LOOP_LEARN_QUEUE', policy: 'freeze', schemaName: 'loop.learn-queue.v1',
    parse: parseBoundaryLoopLearnQueueV1,
    valid: { version: 1, queries: [{ query: 'HCI' }] },
    invalid: { version: 1, queries: [{ query: 'HCI', token: REJECTED_RUNTIME_SECRET }] },
  },
  {
    id: 'LOOP_GRAPH', policy: 'freeze', schemaName: 'loop.graph.v1',
    parse: parseBoundaryLoopGraphV1,
    valid: { version: 1, nodes: [{ id: 'node-1', kind: 'internal', reads: [], writes: [] }], edges: [] },
    invalid: { version: 1, nodes: [{ id: 'node-1', kind: 'internal', reads: [], writes: [], token: REJECTED_RUNTIME_SECRET }], edges: [] },
  },
  {
    id: 'LOOP_CURSORS', policy: 'freeze', schemaName: 'loop.cursors.v1',
    parse: parseBoundaryLoopCursorsV1,
    valid: { 'edge-1': { lines: 1 } }, invalid: { 'edge-1': { lines: 1, token: REJECTED_RUNTIME_SECRET } },
  },
  {
    id: 'LOOP_LEDGER_LINE', policy: 'freeze', schemaName: 'loop.ledger-line.v1',
    parse: parseBoundaryLoopLedgerLineV1,
    valid: loopLedger, invalid: { ...loopLedger, token: REJECTED_RUNTIME_SECRET },
  },
  {
    id: 'RAG_INDEX', policy: 'freeze', schemaName: 'rag.index.v1',
    parse: parseBoundaryRagIndexV1,
    valid: { version: 2, updatedAt: '2026-08-27T00:00:00.000Z', chunks: [ragChunk] },
    invalid: { version: 2, updatedAt: '2026-08-27T00:00:00.000Z', chunks: [{ ...ragChunk, token: REJECTED_RUNTIME_SECRET }] },
  },
  {
    id: 'RAG_RERANK_RESPONSE', policy: 'INDETERMINATE', schemaName: 'rag.rerank-response.v1',
    parse: parseBoundaryRagRerankResponseV1,
    valid: { ranked: ['chunk-1'] }, invalid: { ranked: ['chunk-1'], token: REJECTED_RUNTIME_SECRET },
  },
  {
    id: 'RAG_SHARD_MANIFEST', policy: 'freeze', schemaName: 'rag.shard-manifest.v1',
    parse: parseBoundaryRagShardManifestV1,
    valid: { schemaVersion: 1, source: 'rag-index-v2', updatedAt: '2026-08-27T00:00:00.000Z', chunkCount: 0, shards: [] },
    invalid: { schemaVersion: 1, source: 'rag-index-v2', updatedAt: '2026-08-27T00:00:00.000Z', chunkCount: 0, shards: [], token: REJECTED_RUNTIME_SECRET },
  },
  {
    id: 'RAG_SHARD_LINE', policy: 'freeze', schemaName: 'rag.shard-line.v1',
    parse: parseBoundaryRagShardLineV1,
    valid: ragChunk, invalid: { ...ragChunk, token: REJECTED_RUNTIME_SECRET },
  },
  {
    id: 'RUN_RECORD_LINE', policy: 'freeze', schemaName: 'runs.record-line.v1',
    parse: parseBoundaryRunRecordLineV1,
    valid: {
      schemaVersion: 1, runId: 'run-1', toolId: 'read-tool', toolSafety: 'read_only',
      args: {}, status: 'succeeded', requestedAt: '2026-08-27T00:00:00.000Z',
    },
    invalid: {
      schemaVersion: 1, runId: 'run-1', toolId: 'read-tool', toolSafety: 'read_only',
      args: {}, status: 'succeeded', requestedAt: '2026-08-27T00:00:00.000Z', token: REJECTED_RUNTIME_SECRET,
    },
  },
  {
    id: 'SAFETY_POLICY', policy: 'deny', schemaName: 'safety.policy.v1',
    parse: parseBoundarySafetyPolicyV1,
    valid: { version: 1, defaultSafetyClass: 'human_only', entries: [] },
    invalid: { version: 1, defaultSafetyClass: 'human_only', entries: [], token: REJECTED_RUNTIME_SECRET },
  },
  {
    id: 'MATURITY_POLICY', policy: 'deny', schemaName: 'safety.maturity-policy.v1',
    parse: parseBoundaryMaturityPolicyV1,
    valid: { version: 1, entries: [] },
    invalid: { version: 1, entries: [], token: REJECTED_RUNTIME_SECRET },
  },
  {
    id: 'SHADOW_LEDGER_LINE', policy: 'invalid_report', schemaName: 'scorecard.shadow-ledger-line.v1',
    parse: (source) => parseBoundaryShadowLedgerLineV1(source, shadowRunCodec),
    valid: { id: 'shadow-1', kind: 'shadow-run', automationId: 'auto-1', findingId: 'finding-1', automatedAction: {}, at: '2026-08-27T00:00:00.000Z' },
    invalid: { id: 'shadow-1', kind: 'shadow-run', automationId: 'auto-1', findingId: 'finding-1', automatedAction: {}, at: '2026-08-27T00:00:00.000Z', token: REJECTED_RUNTIME_SECRET },
  },
  {
    id: 'TIME_SAVED_LINE', policy: 'invalid_report', schemaName: 'scorecard.time-saved-line.v1',
    parse: parseBoundaryTimeSavedLineV1,
    valid: { id: 'time-1', kind: 'report-generated', estimateMinutes: 5, basis: 'study-1', at: '2026-08-27T00:00:00.000Z' },
    invalid: { id: 'time-1', kind: 'report-generated', estimateMinutes: 5, basis: 'study-1', at: '2026-08-27T00:00:00.000Z', token: REJECTED_RUNTIME_SECRET },
  },
  {
    id: 'INTENDED_SPEC', policy: 'deny', schemaName: 'spec.intended-spec.v1',
    parse: parseBoundaryIntendedSpecV1,
    valid: { id: 'spec-1', product: 'HCI', version: '1.0', items: [] },
    invalid: { id: 'spec-1', product: 'HCI', version: '1.0', items: [], token: REJECTED_RUNTIME_SECRET },
  },
  {
    id: 'SHARED_JSONL_RECORD', policy: 'freeze', schemaName: 'shared.jsonl-record.v1',
    parse: (source) => parseBoundarySharedJsonlRecordV1(source, simpleCodec),
    valid: { id: 'record-1', value: 'ok' },
    invalid: { id: 'record-1', value: 'ok', token: REJECTED_RUNTIME_SECRET },
  },
];
