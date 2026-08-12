/**
 * Loop-graph tick runner — the single entry a scheduler (cron/launchd) calls.
 * Design: docs/plans/designs/001-loop-graph-runtime.md. One tick: check every
 * declared edge's trigger against its cursor, run due executors, append the
 * ledger, print the tick result as JSON. Idempotent — a tick with no new
 * events is all-noop. Never approves anything (gate nodes stay gate-pending).
 */
import { execFileSync } from 'node:child_process';
import { loadEnvFile } from '../packages/sangfor-collector/src/load-env.js';
import { resolveRepoData } from '../packages/shared/src/index.js';
import { runLoopTick } from '../packages/sangfor-loop/src/index.js';
import { runGapQueriesExecutor } from '../packages/sangfor-loop/src/executors/gap-queries.js';
import { runEmbeddingDriftExecutor } from '../packages/sangfor-loop/src/executors/embedding-drift.js';
import { runRagEvalExecutor } from '../packages/sangfor-loop/src/executors/rag-eval.js';
import { runLearnSourcesExecutor } from '../packages/sangfor-loop/src/executors/learn-sources.js';
import { resolveEmbeddingModelFromEnv } from '../packages/sangfor-rag/src/embedding-provider.js';

loadEnvFile('.env');

async function main(): Promise<void> {
  const result = await runLoopTick({
    executors: {
      'gap-queries': (ctx) => runGapQueriesExecutor({ newLines: ctx.newLines ?? [] }),
      'embedding-drift': () => {
        const drift = runEmbeddingDriftExecutor({ configuredModel: resolveEmbeddingModelFromEnv() });
        // Re-embedding is expensive, provider-dependent work — detection is the
        // default; execution stays behind an explicit opt-in.
        if (drift.drift && process.env.SANGFOR_LOOP_AUTO_REEMBED === '1') {
          execFileSync('node_modules/.bin/tsx', ['scripts/rag-reembed.ts'], { cwd: resolveRepoData('.'), stdio: 'inherit' });
          return { detail: `${drift.detail}; auto-reembed executed (SANGFOR_LOOP_AUTO_REEMBED=1)` };
        }
        return drift;
      },
      'learn-sources': () => {
        // Outbound collection is provider-dependent work with real cost and rate
        // limits, so the same opt-in shape as auto-reembed applies: queue by
        // default, dispatch only when explicitly enabled.
        const learn = runLearnSourcesExecutor({});
        return { detail: learn.detail };
      },
      'rag-eval': () => {
        const evalRun = runRagEvalExecutor({});
        const summary = evalRun.results.map((p) => `${p.product}:${p.ok ? 'ok' : `FAIL[${p.failed.join(',')}]`}`).join(' ');
        return { detail: `${evalRun.detail} — ${summary}` };
      },
    },
  });
  console.log(JSON.stringify(result, null, 2));
  const errors = result.outcomes.filter((o) => o.outcome === 'error');
  if (errors.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.stack ?? error.message : error));
  process.exitCode = 1;
});
