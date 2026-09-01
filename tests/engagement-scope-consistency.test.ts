import { testFileLocalWriteAuthority, testLocalWriteAuthority } from './helpers/local-write-authority.js';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveEngagementScopedData, resolveRepoData } from '../packages/shared/src/index.js';
import { submitFeedback } from '../packages/sangfor-feedback/src/index.js';
import { GAP_QUERIES_WATCH } from '../packages/sangfor-loop/src/executors/gap-queries.js';
import { AuditLedger } from '../packages/sangfor-hci-client/src/audit-ledger.js';

/**
 * Paired writers/readers of one engagement-scoped root must resolve the SAME
 * partition. Several modules resolve a scoped root unscoped, so with an active
 * engagement the pair diverges: one side writes inside the engagement partition
 * and the other reads the shared root, silently.
 *
 * Characterization + regression:
 *  - `SANGFOR_ENGAGEMENT_ID` UNSET  -> paths byte-identical to today (no migration);
 *  - `SANGFOR_ENGAGEMENT_ID` SET    -> both members of a pair agree on the segment.
 *
 * All resolvers under test read process.env at call time, so no module cache
 * busting is required.
 */

const ENGAGEMENT = 'acme-dc-2026';
const ENV_KEYS = [
  'SANGFOR_ENGAGEMENT_ID',
  'SANGFOR_EVIDENCE_ROOT',
  'SANGFOR_FEEDBACK_ROOT',
  'SANGFOR_SEARCH_GAPS_PATH',
] as const;

let root: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'scope-consistency-'));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  delete process.env.SANGFOR_SEARCH_GAPS_PATH;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('engagement scope consistency', () => {
  it('feedback: package store writes inside the partition the server reads', async () => {
    process.env.SANGFOR_FEEDBACK_ROOT = join(root, 'feedback');
    process.env.SANGFOR_ENGAGEMENT_ID = ENGAGEMENT;

    // apps/mcp-server resolves the feedback root scoped (feedbackRoot()).
    const serverFacing = resolveEngagementScopedData('data/feedback', 'SANGFOR_FEEDBACK_ROOT');
    expect(serverFacing).toContain(ENGAGEMENT);

    const written = await submitFeedback({
      product: 'HCI',
      feedbackType: 'accuracy',
      severity: 'low',
      feedbackText: 'scope consistency probe',
      sourceRole: 'engineer',
    }, testLocalWriteAuthority('feedback_lessons'));
    expect(written.id).toBeTruthy();

    expect(
      existsSync(join(serverFacing, 'feedback.jsonl')),
      'feedback package wrote outside the engagement partition the server reads',
    ).toBe(true);
  });

  it('search-gap file from the loop executor matches the server-side scoped path', () => {
    process.env.SANGFOR_FEEDBACK_ROOT = join(root, 'feedback');
    process.env.SANGFOR_ENGAGEMENT_ID = ENGAGEMENT;

    const serverSide = join(
      resolveEngagementScopedData('data/feedback', 'SANGFOR_FEEDBACK_ROOT'),
      'search-gaps.jsonl',
    );
    expect(GAP_QUERIES_WATCH()).toBe(serverSide);
  });

  it('HCI audit ledger writes change-runs inside the engagement partition', () => {
    process.env.SANGFOR_ENGAGEMENT_ID = ENGAGEMENT;
    process.env.SANGFOR_EVIDENCE_ROOT = join(root, 'evidence');

    expect(
      new AuditLedger({ authority: testLocalWriteAuthority('audit') }).pathFor('run-1'),
      'audit ledger wrote outside the engagement partition',
    ).toContain(ENGAGEMENT);
  });

  it('unset engagement keeps resolved paths byte-identical to the unscoped root', () => {
    delete process.env.SANGFOR_ENGAGEMENT_ID;
    process.env.SANGFOR_FEEDBACK_ROOT = join(root, 'feedback');

    expect(resolveEngagementScopedData('data/feedback', 'SANGFOR_FEEDBACK_ROOT')).toBe(
      resolveRepoData('data/feedback', 'SANGFOR_FEEDBACK_ROOT'),
    );
    expect(GAP_QUERIES_WATCH()).toBe(
      join(resolveRepoData('data/feedback', 'SANGFOR_FEEDBACK_ROOT'), 'search-gaps.jsonl'),
    );
  });

  it('an explicit search-gap path override is honoured and never scoped', () => {
    process.env.SANGFOR_ENGAGEMENT_ID = ENGAGEMENT;
    const explicit = join(root, 'explicit', 'gaps.jsonl');
    process.env.SANGFOR_SEARCH_GAPS_PATH = explicit;

    expect(GAP_QUERIES_WATCH()).toBe(explicit);
  });
});
