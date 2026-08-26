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

  it('Given all legacy gates pass without an executor, When apply is requested, Then it typed-refuses instead of returning false success', async () => {
    process.env.SANGFOR_ALLOW_REAL_EXECUTION = 'true';

    const r = await applyApprovedProductChange({ plan: criticalPlan(), approval: APPROVAL });

    expect(r).toMatchObject({
      ok: false,
      code: 'LEGACY_PRODUCT_APPLY_DEPRECATED',
      mutationPerformed: false,
    });
  });

  it('Given an executor is attached to the legacy API, When apply is requested, Then it refuses without invoking the executor', async () => {
    process.env.SANGFOR_ALLOW_REAL_EXECUTION = 'true';
    let called = false;
    const executor: ProductChangeExecutor = async () => {
      called = true;
      return { mutationPerformed: true };
    };

    const r = await applyApprovedProductChange({ plan: criticalPlan(), approval: APPROVAL, executor });

    expect(r).toMatchObject({ ok: false, code: 'LEGACY_PRODUCT_APPLY_DEPRECATED', mutationPerformed: false });
    expect(called).toBe(false);
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
