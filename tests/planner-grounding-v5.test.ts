import { describe, expect, it } from 'vitest';
import type { ConfigPlan } from '../packages/shared/src/index.js';
import { assessPlanGrounding } from '../packages/sangfor-planner/src/grounding-assessment.js';
const plan = (): ConfigPlan => ({ id: 'plan', customerName: 'test', product: 'HCI', version: '6.11.3', planTitle: 'Draft', planSummary: 'Draft only', riskLevel: 'low',
  precheck: [], steps: [], approvalRequiredSteps: [], rollbackPlan: [], validationPlan: [], wikiReferences: [], lessonReferences: [],
  manualReferences: [{ id: 'ref', product: 'HCI', version: '6.11.3', title: 'Manual', text: 'Check MTU.', sourceType: 'manual', trustLevel: 'official' }] });
describe('plan grounding assessment', () => {
  it('does not promote matching references to verified answers', () => {
    expect(assessPlanGrounding(plan())).toMatchObject({ status: 'UNVERIFIED_TEMPLATE', answerReady: false });
  });
  it('rejects product and version mismatches', () => {
    const p = plan(); p.manualReferences[0].product = 'NGFW'; p.manualReferences[0].version = '8.0.107';
    expect(assessPlanGrounding(p)).toMatchObject({ status: 'INVALID_REFERENCES', issues: ['REFERENCE_PRODUCT_MISMATCH', 'REFERENCE_VERSION_MISMATCH'] });
  });
  it('reports missing evidence and refuses phantom citations', () => {
    const p = plan(); p.manualReferences = [];
    expect(assessPlanGrounding(p).status).toBe('INSUFFICIENT_EVIDENCE');
    p.steps = [{ id: 'step', title: 'Check', description: 'Check', product: 'HCI', phase: 'precheck', approvalRequired: false, riskLevel: 'low', references: ['invented'] }];
    expect(assessPlanGrounding(p).issues).toContain('UNKNOWN_STEP_REFERENCE');
  });
});

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
it('does not replace an indexed no-hit result with unrelated seed references', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plan-grounding-'));
  try {
    const index = join(dir, 'index.json');
    writeFileSync(index, JSON.stringify({version: 1, updatedAt: new Date(0).toISOString(), chunks: [{ ...plan().manualReferences[0], filePath: 'manual.md', vector: [], contentHash: 'test' }]}));
    const moduleUrl = new URL('file://' + resolve('packages/sangfor-planner/src/index.ts')).href;
    const source = `const { generateConfigPlanAsync } = await import(${JSON.stringify(moduleUrl)}); const result = await generateConfigPlanAsync({ customerName: 'test', product: 'HCI', version: '99.99.99', requirements: ['unsupported configuration'] }); console.log(JSON.stringify(result));`;
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { encoding: 'utf8', env: { ...process.env, SANGFOR_RAG_INDEX_PATH: index, SANGFOR_EMBEDDING_PROVIDER: 'hash', SANGFOR_MIMO_RERANK_ENABLED: '0', SANGFOR_LOCAL_RERANK_ENABLED: '0' } });
    const result = JSON.parse(output);
    expect(result.manualReferences).toEqual([]);
    expect(result.wikiReferences).toEqual([]);
    expect(result.grounding).toMatchObject({ status: 'INSUFFICIENT_EVIDENCE', answerReady: false });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
