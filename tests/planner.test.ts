import { describe, expect, it } from 'vitest';
import { analyzeProject, generateConfigPlan, validateConfigPlan } from '../packages/sangfor-planner/src/index.js';
import { requiresApprovalForText } from '../packages/sangfor-approval/src/index.js';
import { startOperatorSession, executeConsoleAction } from '../packages/sangfor-operator/src/index.js';
import { submitFeedback, extractLesson } from '../packages/sangfor-feedback/src/index.js';
import { proposeWikiUpdate, applyWikiUpdate, approveWikiUpdate } from '../packages/sangfor-wiki/src/index.js';
import { runPlannerEval } from '../packages/sangfor-evals/src/index.js';

describe('Sangfor Engineer MCP MVP', () => {
  it('detects HCI project and missing inputs', () => {
    const analysis = analyzeProject({ customerName: 'Test', product: 'HCI', environment: { nodeCount: 3 } });
    expect(analysis.detectedProduct).toBe('HCI');
    expect(analysis.missingInputs).toContain('managementNetwork');
  });

  it('generates valid HCI plan with MTU precheck', () => {
    const plan = generateConfigPlan({ customerName: 'Test', product: 'HCI', environment: { nodeCount: 3 }, requirements: ['VMware migration'] });
    expect(validateConfigPlan(plan).ok).toBe(true);
    expect(JSON.stringify(plan).toLowerCase()).toContain('mtu');
    expect(runPlannerEval(plan).ok).toBe(true);
  });

  it('requires approval for Apply action', () => {
    expect(requiresApprovalForText('Apply network configuration').required).toBe(true);
  });

  it('blocks non-dry-run dangerous console action', () => {
    const session = startOperatorSession({ product: 'HCI' });
    const result = executeConsoleAction(session.id, { type: 'click', target: 'Apply', dryRun: false });
    expect(result.ok).toBe(false);
    expect(result.approvalRequired).toBe(true);
  });

  it('blocks wiki apply before approval', () => {
    const p = proposeWikiUpdate({ lessonTitle: 'Test lesson', lessonBody: 'Body' });
    expect(() => applyWikiUpdate(p.id)).toThrow();
    approveWikiUpdate(p.id, 'approved');
    expect(applyWikiUpdate(p.id).status).toBe('applied');
  });

  it('converts feedback to lesson', () => {
    const feedback = submitFeedback({ product: 'HCI', feedbackType: 'missing_precheck', severity: 'medium', feedbackText: 'MTU precheck missing', sourceRole: 'engineer' });
    const lesson = extractLesson(feedback.id);
    expect(lesson.feedbackId).toBe(feedback.id);
  });
});

import { writeFileSync, mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestDocument, ragSearch } from '../packages/sangfor-rag/src/index.js';
import { applyObsidianWikiUpdate } from '../packages/sangfor-wiki/src/index.js';
import { createFineTuneDataset, validateFineTuneDataset, createFineTuneJobSpec } from '../packages/sangfor-finetune/src/index.js';

describe('Included real integration surfaces', () => {
  it('ingests text/markdown into a real local RAG index and searches it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sangfor-rag-'));
    const docPath = join(dir, 'hci.md');
    const indexPath = join(dir, 'index.json');
    writeFileSync(docPath, '# HCI Guide\n\nStorage network MTU must be validated before cluster initialization.');
    const result = await ingestDocument({ filePath: docPath, product: 'HCI', indexPath });
    expect(result.chunkCount).toBeGreaterThan(0);
    const hits = ragSearch({ product: 'HCI', query: 'storage MTU cluster', indexPath });
    expect(hits[0].text.toLowerCase()).toContain('mtu');
  });

  it('writes approved proposal to an Obsidian vault path', async () => {
    const vaultPath = mkdtempSync(join(tmpdir(), 'obsidian-'));
    const p = proposeWikiUpdate({ lessonTitle: 'HCI rollback lesson', lessonBody: 'Always keep rollback window.', targetPage: 'Sangfor/HCI/Lessons.md', adapter: 'obsidian' });
    approveWikiUpdate(p.id, 'approved');
    await applyObsidianWikiUpdate({ proposalId: p.id, vaultPath });
    const notePath = join(vaultPath, 'Sangfor/HCI/Lessons.md');
    expect(existsSync(notePath)).toBe(true);
    expect(readFileSync(notePath, 'utf8')).toContain('HCI rollback lesson');
  });

  it('creates and validates fine-tune dataset manifest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ft-'));
    const datasetPath = join(dir, 'dataset.jsonl');
    const dataset = createFineTuneDataset({
      product: 'HCI',
      taskType: 'config_planning',
      outputPath: datasetPath,
      examples: [{ input: 'Create HCI 3-node plan', expectedOutput: 'Include precheck, rollback, validation, and approval gates.' }]
    });
    expect(dataset.count).toBe(1);
    expect(validateFineTuneDataset(dataset.path).ok).toBe(true);
    expect(createFineTuneJobSpec({ datasetPath: dataset.path, product: 'HCI', taskType: 'config_planning' }).status).toBe('ready_for_review');
  });
});
