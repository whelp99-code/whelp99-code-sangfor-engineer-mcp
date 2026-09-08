import { testFileLocalWriteAuthority, testLocalWriteAuthority } from './helpers/local-write-authority.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { submitFeedback, extractLesson, listLessons } from '../packages/sangfor-feedback/src/index.js';
import { createEvalCaseFromFeedback, runPlannerEval } from '../packages/sangfor-evals/src/index.js';
import { proposeWikiUpdate, approveWikiUpdate, applyWikiUpdate, mintWikiApproval } from '../packages/sangfor-wiki/src/index.js';
import { generateConfigPlan } from '../packages/sangfor-planner/src/index.js';

describe('Learning-loop state survives restart (tech-debt #2)', () => {
  const saved = { ...process.env };
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'll-'));
    process.env.SANGFOR_FEEDBACK_ROOT = join(root, 'feedback');
    process.env.SANGFOR_EVALS_ROOT = join(root, 'evals');
    process.env.SANGFOR_WIKI_ROOT = join(root, 'wiki');
  });
  afterEach(() => {
    process.env = { ...saved };
    rmSync(root, { recursive: true, force: true });
  });

  it('feedback → lesson is folded back from disk (no in-memory cache)', async () => {
    const fb = await submitFeedback({ product: 'HCI', feedbackType: 'bug', severity: 'high', feedbackText: 'MTU mismatch', sourceRole: 'engineer' }, testLocalWriteAuthority('feedback_lessons'));
    const lesson = await extractLesson(fb.id, testLocalWriteAuthority('feedback_lessons'));
    expect(listLessons().map((l) => l.id)).toContain(lesson.id);
  });

  it('a user-added eval case is loaded by runPlannerEval after persistence', async () => {
    const ec = await createEvalCaseFromFeedback({ product: 'HCI', name: 'jumbo frames check', requiredText: 'zznotinplanzz' }, testLocalWriteAuthority('evals'));
    const plan = generateConfigPlan({ customerName: 'T', product: 'HCI', environment: { nodeCount: 3 }, requirements: ['VMware migration'] });
    expect(runPlannerEval(plan).results.map((r) => r.id)).toContain(ec.id);
  });

  it('wiki proposal + approval persist so a later apply sees the approved status', async () => {
    process.env.SANGFOR_WIKI_APPROVAL_SECRET = 'tok';
    const p = await proposeWikiUpdate({ lessonTitle: 'L', lessonBody: 'B' }, testLocalWriteAuthority('wiki_proposals'));
    await approveWikiUpdate(p.id, 'approved', { token: mintWikiApproval(p.id) }, testLocalWriteAuthority('wiki_proposals'));
    expect((await applyWikiUpdate(p.id, testLocalWriteAuthority('wiki_proposals'))).status).toBe('applied');
  });
});
