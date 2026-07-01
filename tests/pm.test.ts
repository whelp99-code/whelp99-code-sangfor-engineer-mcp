import { describe, expect, it } from 'vitest';
import { createPmStore } from '../packages/sangfor-pm/src/index.js';

describe('sangfor-pm — engagements & rollup', () => {
  it('creates an engagement, adds work items, and rolls up status', () => {
    const pm = createPmStore();
    const e = pm.createEngagement({ customer: 'ILJITECH', product: 'EPP' });
    pm.addWorkItem(e.id, { title: 'deploy agents' });
    const w2 = pm.addWorkItem(e.id, { title: 'validate policy' });
    pm.updateWorkItem(w2.id, { status: 'done' });
    const roll = pm.statusRollup(e.id);
    expect(roll.total).toBe(2);
    expect(roll.done).toBe(1);
    expect(roll.percentDone).toBeCloseTo(50, 5);
  });
});

describe('sangfor-pm — PmEvent hash chain (tamper-evident audit)', () => {
  it('chains events and verifies integrity', () => {
    const pm = createPmStore();
    const e = pm.createEngagement({ customer: 'A', product: 'IAG' });
    pm.appendPmEvent(e.id, 'diagnosis_run', { device: '10.80.1.108' });
    pm.appendPmEvent(e.id, 'report_generated', { path: 'x.docx' });
    expect(pm.verifyEventChain(e.id).ok).toBe(true);
  });

  it('detects tampering when an event payload is mutated', () => {
    const pm = createPmStore();
    const e = pm.createEngagement({ customer: 'A', product: 'IAG' });
    pm.appendPmEvent(e.id, 'diagnosis_run', { device: '10.80.1.108' });
    const events = pm.getEvents(e.id);
    events[0].payload = { device: 'TAMPERED' }; // mutate in place
    expect(pm.verifyEventChain(e.id).ok).toBe(false);
  });
});

describe('sangfor-pm — DeviceOccupancy lock (shared-device safety)', () => {
  it('grants a device lock and blocks a second engagement from acquiring it', () => {
    const pm = createPmStore();
    const a = pm.createEngagement({ customer: 'A', product: 'EPP' });
    const b = pm.createEngagement({ customer: 'B', product: 'EPP' });
    expect(pm.acquireDevice('10.80.1.106', a.id, 'engineerA').ok).toBe(true);
    const conflict = pm.acquireDevice('10.80.1.106', b.id, 'engineerB');
    expect(conflict.ok).toBe(false);
    expect(conflict.heldBy?.engagementId).toBe(a.id);
  });

  it('releases the lock so another engagement can acquire it', () => {
    const pm = createPmStore();
    const a = pm.createEngagement({ customer: 'A', product: 'EPP' });
    const b = pm.createEngagement({ customer: 'B', product: 'EPP' });
    pm.acquireDevice('10.80.1.106', a.id, 'engineerA');
    pm.releaseDevice('10.80.1.106', a.id);
    expect(pm.acquireDevice('10.80.1.106', b.id, 'engineerB').ok).toBe(true);
  });

  it('is idempotent for the same engagement re-acquiring its own lock', () => {
    const pm = createPmStore();
    const a = pm.createEngagement({ customer: 'A', product: 'EPP' });
    pm.acquireDevice('10.80.1.106', a.id, 'engineerA');
    expect(pm.acquireDevice('10.80.1.106', a.id, 'engineerA').ok).toBe(true);
  });
});

describe('sangfor-pm — red-team regressions', () => {
  it('rejects addWorkItem for a non-existent engagement (no orphan work items)', () => {
    const pm = createPmStore();
    expect(() => pm.addWorkItem('eng_does_not_exist', { title: 'x' })).toThrow(/not found/i);
  });

  it('does NOT let a different holder in the same engagement steal an existing lock', () => {
    const pm = createPmStore();
    const a = pm.createEngagement({ customer: 'A', product: 'EPP' });
    pm.acquireDevice('10.80.1.106', a.id, 'engineerA');
    const steal = pm.acquireDevice('10.80.1.106', a.id, 'engineerB');
    expect(steal.ok).toBe(false);
    expect(steal.heldBy?.holder).toBe('engineerA'); // original holder preserved
  });

  it('records updateWorkItem in the tamper-evident event chain with the prior status', () => {
    const pm = createPmStore();
    const e = pm.createEngagement({ customer: 'A', product: 'EPP' });
    const w = pm.addWorkItem(e.id, { title: 't' });
    const before = pm.getEvents(e.id).length;
    pm.updateWorkItem(w.id, { status: 'done' });
    const after = pm.getEvents(e.id);
    expect(after.length).toBe(before + 1);
    const last = after[after.length - 1];
    expect(last.type).toBe('work_item_updated');
    expect((last.payload as any).from).toBe('todo');
    expect((last.payload as any).patch).toEqual({ status: 'done' });
    expect(pm.verifyEventChain(e.id).ok).toBe(true);
  });

  it('records releaseDevice as a device_released event with an intact chain', () => {
    const pm = createPmStore();
    const a = pm.createEngagement({ customer: 'A', product: 'EPP' });
    pm.acquireDevice('10.80.1.106', a.id, 'engineerA');
    expect(pm.releaseDevice('10.80.1.106', a.id)).toBe(true);
    const events = pm.getEvents(a.id);
    expect(events.some((ev) => ev.type === 'device_released')).toBe(true);
    expect(pm.verifyEventChain(a.id).ok).toBe(true);
  });
});
