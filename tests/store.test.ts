import { describe, expect, it } from 'vitest';
import { generateConfigPlan } from '../packages/sangfor-planner/src/index.js';
import {
  disconnectStore,
  persistConfigPlan,
  persistFeedbackEvent,
  storeHealthCheck
} from '../packages/sangfor-store/src/index.js';

const runStoreIt = process.env.SANGFOR_RUN_STORE_IT === '1' && Boolean(process.env.DATABASE_URL?.trim());

describe.runIf(runStoreIt)('Prisma store (integration)', () => {
  it('health check and persist plan + feedback', async () => {
    const health = await storeHealthCheck();
    expect(health.ok).toBe(true);

    const plan = generateConfigPlan({
      customerName: 'Store IT',
      product: 'HCI',
      environment: { nodeCount: 3 },
      requirements: ['Validate HA status']
    });
    const planId = await persistConfigPlan(plan);
    expect(planId).toBeTruthy();

    const feedbackId = await persistFeedbackEvent({
      product: 'HCI',
      feedbackType: 'validation_gap',
      severity: 'low',
      feedbackText: 'NTP alert observed during store IT',
      sourceRole: 'engineer'
    });
    expect(feedbackId).toBeTruthy();

    await disconnectStore();
  });
});
