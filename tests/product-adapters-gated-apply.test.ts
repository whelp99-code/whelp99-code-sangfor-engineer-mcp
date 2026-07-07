import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateProductChangePlan, applyApprovedProductChange, type ProductChangeExecutor } from '../packages/sangfor-product-adapters/src/index.js';

const APPROVAL = { approvedBy: 'jmpark', approvalToken: 'signed', changeTicketId: 'CHG-1', rollbackPlanId: 'RB-1' };

function criticalPlan() {
  return generateProductChangePlan({ product: 'HCI_SCP', requirements: ['Enable DRS for the HCI resource pool and verify HA status'] });
}

describe('applyApprovedProductChange — executor seam behind gates (tech-debt #1)', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.SANGFOR_ALLOW_REAL_EXECUTION;
    delete process.env.SANGFOR_ALLOW_PRODUCTION_EXECUTION;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('refuses without approval — executor never runs', async () => {
    let called = false;
    const executor: ProductChangeExecutor = async () => { called = true; return { mutationPerformed: true }; };
    const r = await applyApprovedProductChange({ plan: criticalPlan(), executor });
    expect(r.ok).toBe(false);
    expect(r.approvalRequired).toBe(true);
    expect(r.mutationPerformed).toBe(false);
    expect(called).toBe(false);
  });

  it('refuses when SANGFOR_ALLOW_REAL_EXECUTION is not true — executor never runs', async () => {
    let called = false;
    const executor: ProductChangeExecutor = async () => { called = true; return { mutationPerformed: true }; };
    const r = await applyApprovedProductChange({ plan: criticalPlan(), approval: APPROVAL, executor });
    expect(r.mutationPerformed).toBe(false);
    expect(called).toBe(false);
    expect(String(r.reason)).toMatch(/SANGFOR_ALLOW_REAL_EXECUTION/);
  });

  it('all gates pass but no executor attached → safe stub, no mutation', async () => {
    process.env.SANGFOR_ALLOW_REAL_EXECUTION = 'true';
    const r = await applyApprovedProductChange({ plan: criticalPlan(), approval: APPROVAL });
    expect(r.ok).toBe(true);
    expect(r.mutationPerformed).toBe(false);
    expect(String(r.reason)).toMatch(/No executor attached/);
  });

  it('all gates pass + mock executor → mutation performed, executor saw the approval', async () => {
    process.env.SANGFOR_ALLOW_REAL_EXECUTION = 'true';
    let seenApproval: unknown;
    const executor: ProductChangeExecutor = async (ctx) => {
      seenApproval = ctx.approval;
      return { mutationPerformed: true, details: { appliedTasks: ctx.plan.tasks.length } };
    };
    const r = await applyApprovedProductChange({ plan: criticalPlan(), approval: APPROVAL, executor });
    expect(r.ok).toBe(true);
    expect(r.mutationPerformed).toBe(true);
    expect(seenApproval).toEqual(APPROVAL);
  });

  it('production stays gated even with executor + real-execution flag', async () => {
    process.env.SANGFOR_ALLOW_REAL_EXECUTION = 'true';
    let called = false;
    const executor: ProductChangeExecutor = async () => { called = true; return { mutationPerformed: true }; };
    const r = await applyApprovedProductChange({ plan: criticalPlan(), approval: APPROVAL, environment: 'production', executor });
    expect(r.mutationPerformed).toBe(false);
    expect(called).toBe(false);
    expect(String(r.reason)).toMatch(/PRODUCTION/);
  });
});
