import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runLearnSourcesExecutor } from '../packages/sangfor-loop/src/executors/learn-sources.js';

/**
 * Edge e2 (gap-queries -> learn-sources) used to be declared `manual`, so the
 * engine never fired it and unanswered searches piled up forever. These cases
 * pin the two properties that make automating it safe:
 *
 *  1. an outbound crawl never becomes the silent default;
 *  2. a blocked collector is REPORTED, not swallowed — the stalled
 *     needs-glass.flag sat unread on disk for over a day before this.
 */

let dir: string;
let gapPath: string;
let flagPath: string;

function writeQueries(queries: unknown) {
  writeFileSync(gapPath, JSON.stringify({ version: 1, queries }), 'utf8');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'learn-sources-'));
  gapPath = join(dir, 'gap-queries.json');
  flagPath = join(dir, 'needs-glass.flag');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('learn-sources executor', () => {
  it('queues pending gap terms without crawling by default', () => {
    writeQueries([{ query: 'scp 볼륨 서비스 503 장애 복구 절차', count: 1 }]);
    const result = runLearnSourcesExecutor({ gapQueriesPath: gapPath, glassFlagPath: flagPath });

    expect(result.autoCollect).toBe(false);
    expect(result.pending).toHaveLength(1);
    expect(result.detail).toContain('queued');
    expect(result.detail).toContain('SANGFOR_LOOP_AUTO_COLLECT=1');
    expect(result.blockedReason).toBeUndefined();
  });

  it('marks terms dispatchable only when the operator opts in', () => {
    writeQueries([{ query: 'a' }, { query: 'b' }]);
    const result = runLearnSourcesExecutor({
      gapQueriesPath: gapPath,
      glassFlagPath: flagPath,
      autoCollect: true,
    });

    expect(result.autoCollect).toBe(true);
    expect(result.detail).toContain('dispatchable');
    expect(result.detail).toContain('2 gap term(s)');
  });

  it('surfaces a blocked KB collector instead of letting the flag rot', () => {
    writeQueries([{ query: 'q1' }]);
    writeFileSync(flagPath, '2026-08-11_03-00-05 glass_cdp_unreachable', 'utf8');

    const result = runLearnSourcesExecutor({ gapQueriesPath: gapPath, glassFlagPath: flagPath });
    expect(result.blockedReason).toContain('glass_cdp_unreachable');
    expect(result.detail).toContain('blocked');
  });

  it('reports the block even when no terms are pending', () => {
    writeQueries([]);
    writeFileSync(flagPath, 'glass_cdp_unreachable', 'utf8');

    const result = runLearnSourcesExecutor({ gapQueriesPath: gapPath, glassFlagPath: flagPath });
    expect(result.detail).toContain('blocked');
    expect(result.blockedReason).toBe('glass_cdp_unreachable');
  });

  it('clears the blocked state once the flag is gone', () => {
    writeQueries([{ query: 'q1' }]);
    const result = runLearnSourcesExecutor({ gapQueriesPath: gapPath, glassFlagPath: flagPath });
    expect(result.blockedReason).toBeUndefined();
    expect(result.detail).toContain('queued');
  });

  it('treats a missing queue as nothing to do, not an error', () => {
    const result = runLearnSourcesExecutor({
      gapQueriesPath: join(dir, 'absent.json'),
      glassFlagPath: flagPath,
    });
    expect(result.pending).toEqual([]);
    expect(result.detail).toContain('no pending gap queries');
  });

  it('does not mistake a corrupt queue for an empty one silently succeeding on junk', () => {
    writeFileSync(gapPath, '{not json', 'utf8');
    const result = runLearnSourcesExecutor({ gapQueriesPath: gapPath, glassFlagPath: flagPath });
    expect(result.pending).toEqual([]);
    expect(result.detail).toContain('no pending gap queries');
  });

  it('ignores malformed entries rather than dispatching them', () => {
    writeQueries([{ query: 'good' }, { notAQuery: true }, null]);
    const result = runLearnSourcesExecutor({ gapQueriesPath: gapPath, glassFlagPath: flagPath });
    expect(result.pending.map((p) => p.query)).toEqual(['good']);
  });
});
