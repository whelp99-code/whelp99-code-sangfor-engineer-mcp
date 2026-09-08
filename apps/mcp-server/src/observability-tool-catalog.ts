import { listChangeRunIds, isSafeRunId, buildChangeRunReport } from '../../../packages/sangfor-evidence/src/index.js';
import { join, relative } from 'node:path';
import { resolveEngagementScopedData, writeFileAtomicSync, activeEngagementId, resolveRepoData } from '../../../packages/shared/src/index.js';
import { paginateOptionalField } from './catalog-query-support.js';
import { feedbackRoot, readSearchGaps } from './search-gap-support.js';
import { buildLoopStatus } from '../../../packages/sangfor-loop/src/index.js';
import { runSafetySelftest } from './safety-selftest.js';
import type { ToolCatalogEntry } from './mcp-contracts.js';

export const observabilityToolCatalog: readonly ToolCatalogEntry[] = [
  ["sangfor_session_report", {
    description: 'One-click session/change-run work report: overview, step timeline, read-back/verification results, hash-chain integrity (via AuditLedger.verify), and related evidence files, built from the data/evidence change-run ledger. Omit runId to list available change-run ids (read-only). Pass save:true to also write the Markdown report under data/evidence/reports/<runId>.md.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'Change-run id (ledger file basename under data/evidence/change-runs/). Omit to list available ids.' },
        format: { type: 'string', enum: ['markdown', 'json'], description: 'Default markdown.' },
        save: { type: 'boolean', description: 'Also write the Markdown report to data/evidence/reports/<runId>.md. Default false.' },
      },
    },
    handler: (args: { runId?: string; format?: 'markdown' | 'json'; save?: boolean }) => {
      if (!args.runId) return { availableRunIds: listChangeRunIds() };
      if (!isSafeRunId(args.runId)) return { error: `INVALID_RUN_ID: "${args.runId}" is not a safe path segment.` };
      const { markdown, json } = buildChangeRunReport({ runId: args.runId });
      const format = args.format ?? 'markdown';
      const report = format === 'json' ? json : markdown;
      if (!args.save) return { format, report };
      const savedPath = join(resolveEngagementScopedData('data/evidence', 'SANGFOR_EVIDENCE_ROOT'), 'reports', `${args.runId}.md`);
      writeFileAtomicSync(savedPath, markdown);
      return { format, report, savedPath };
    },
  }],
  ["sangfor_search_gaps", {
    description: 'Read-only: list recorded search gaps — sangfor_rag_search calls that returned 0 hits or a top score below SANGFOR_RAG_WEAK_THRESHOLD (default 0.15). Feeds what to ingest/author next. Optional cursor/limit page the list; omit both for the full list (default, backward-compatible). Disable capture entirely with SANGFOR_SEARCH_GAP_CAPTURE=0.',
    inputSchema: { type: 'object', properties: { cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } } },
    handler: (args: { cursor?: string; limit?: number }) => paginateOptionalField(readSearchGaps(), args, (g) => g.id, 'gaps'),
  }],
  ["sangfor_loop_status", {
    description: 'Read-only: loop-graph runtime status — the declared pipeline graph summary (data/graph/pipeline.json), per-edge cursors and pending event counts, human-approval gate nodes, and the most recent loop-ledger entries. The loop engine itself only runs read/collect/eval work; gate nodes are never auto-executed. Design: docs/plans/designs/001-loop-graph-runtime.md.',
    inputSchema: { type: 'object', properties: { tail: { type: 'integer', minimum: 1, maximum: 200, description: 'How many recent ledger entries to include (default 20).' } } },
    handler: (args: { tail?: number }) => buildLoopStatus({ tail: args.tail }),
  }],
  ["sangfor_safety_selftest", {
    description: 'Read-only self-test: proves the fail-closed safety gates actually refuse an unapproved action — the operator real-execution gate (verified in a clean-env child process, no device/network contact), the http-bridge destructive-tool guard, a forged HMAC approval-signature rejection, and single-use nonce replay rejection. allPass means every EXECUTED check passed; a check only falls back to outcome:"skipped" (never counted toward allPass) if its subprocess could not be run at all (spawn failure/timeout) — skippedCount reports how many that applies to.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => runSafetySelftest(),
  }],
  ["sangfor_engagement_scope", {
    description: 'Read-only: whether a customer-engagement data scope is active (SANGFOR_ENGAGEMENT_ID) and which data roots it isolates — the run ledger, search-gap feedback file, and saved session reports. Inactive (the default) means every deployment shares the same unscoped repo data roots. An invalid SANGFOR_ENGAGEMENT_ID throws rather than silently falling back.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => {
      const engagementId = activeEngagementId();
      const repoRoot = resolveRepoData('.');
      const toRel = (abs: string) => relative(repoRoot, abs) || '.';
      const runsRoot = resolveEngagementScopedData('data/runs', 'SANGFOR_RUNS_ROOT');
      const reportsRoot = join(resolveEngagementScopedData('data/evidence', 'SANGFOR_EVIDENCE_ROOT'), 'reports');
      return {
        active: engagementId !== undefined,
        engagementId,
        scopedRoots: [
          { name: 'runs', path: toRel(runsRoot) },
          { name: 'search-gaps-feedback', path: toRel(feedbackRoot()) },
          { name: 'session-reports', path: toRel(reportsRoot) },
        ],
      };
    },
  }],
];
