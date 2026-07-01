import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
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

  it('detects TAIL TRUNCATION — dropping the last event(s) leaves a valid prefix but must fail', () => {
    const pm = createPmStore();
    const e = pm.createEngagement({ customer: 'A', product: 'IAG' });
    pm.appendPmEvent(e.id, 'e1', { a: 1 });
    pm.appendPmEvent(e.id, 'e2', { a: 2 });
    pm.appendPmEvent(e.id, 'e3', { a: 3 });
    pm.getEvents(e.id).pop(); // truncate the tail — remaining [e1,e2] is internally consistent
    expect(pm.verifyEventChain(e.id).ok).toBe(false);
  });

  it('detects seq reordering', () => {
    const pm = createPmStore();
    const e = pm.createEngagement({ customer: 'A', product: 'IAG' });
    pm.appendPmEvent(e.id, 'e1', { a: 1 });
    pm.appendPmEvent(e.id, 'e2', { a: 2 });
    const ev = pm.getEvents(e.id);
    [ev[0], ev[1]] = [ev[1], ev[0]]; // swap order
    expect(pm.verifyEventChain(e.id).ok).toBe(false);
  });
});

describe('sangfor-pm — keyed audit chain (tamper-evidence against a recomputing adversary)', () => {
  it('reports keyed=true only when a chain secret is configured', () => {
    const keyed = createPmStore({ secret: 's1' });
    const ek = keyed.createEngagement({ customer: 'A', product: 'IAG' });
    keyed.appendPmEvent(ek.id, 'x', { a: 1 });
    expect(keyed.verifyEventChain(ek.id).keyed).toBe(true);

    const unkeyed = createPmStore();
    const eu = unkeyed.createEngagement({ customer: 'A', product: 'IAG' });
    unkeyed.appendPmEvent(eu.id, 'x', { a: 1 });
    expect(unkeyed.verifyEventChain(eu.id).keyed).toBe(false);
  });

  it('binds event hashes to the secret so an identical event hashes differently under a different key', () => {
    const a = createPmStore({ secret: 'secret-A' });
    const b = createPmStore({ secret: 'secret-B' });
    const ea = a.createEngagement({ customer: 'X', product: 'HCI' });
    const eb = b.createEngagement({ customer: 'X', product: 'HCI' });
    a.appendPmEvent(ea.id, 'evt', { k: 1 });
    b.appendPmEvent(eb.id, 'evt', { k: 1 });
    expect(a.getEvents(ea.id)[0].hash).not.toBe(b.getEvents(eb.id)[0].hash);
  });

  it('defeats a sophisticated tamperer who recomputes a hash without the secret', () => {
    const pm = createPmStore({ secret: 'server-side-pm-secret' });
    const e = pm.createEngagement({ customer: 'A', product: 'IAG' });
    pm.appendPmEvent(e.id, 'diagnosis_run', { device: 'orig' });
    const events = pm.getEvents(e.id);
    // Attacker with write access mutates the payload and forges a hash using the
    // PUBLIC algorithm (no secret). Keyed verification must still reject it.
    events[0].payload = { device: 'TAMPERED' };
    events[0].hash = createHash('sha256')
      .update(`GENESIS|1|diagnosis_run|${JSON.stringify({ device: 'TAMPERED' })}`)
      .digest('hex');
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

  it('idempotent re-acquire preserves the ORIGINAL acquiredAt (occupancy age cannot be reset)', () => {
    const pm = createPmStore();
    const a = pm.createEngagement({ customer: 'A', product: 'EPP' });
    const first = pm.acquireDevice('10.80.1.106', a.id, 'engineerA');
    const firstAt = first.heldBy!.acquiredAt;
    const again = pm.acquireDevice('10.80.1.106', a.id, 'engineerA');
    expect(again.heldBy!.acquiredAt).toBe(firstAt);
    expect(pm.deviceOccupancy()[0].acquiredAt).toBe(firstAt);
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

  it('statusRollup throws on an unknown engagement (consistent with addWorkItem — no fake 0%)', () => {
    const pm = createPmStore();
    expect(() => pm.statusRollup('eng_nope')).toThrow(/not found/i);
  });

  it('getEngagement returns the engagement for a valid id and undefined for an unknown one', () => {
    const pm = createPmStore();
    const e = pm.createEngagement({ customer: 'A', product: 'EPP' });
    expect(pm.getEngagement(e.id)?.customer).toBe('A');
    expect(pm.getEngagement('nope')).toBeUndefined();
  });
});

describe('sangfor-pm — renderStatusReport (citable narrative from recorded events)', () => {
  it('includes rollup %, every recorded event seq, and derives only from events', () => {
    const pm = createPmStore();
    const e = pm.createEngagement({ customer: 'ACME', product: 'IAG' });
    const w = pm.addWorkItem(e.id, { title: 'deploy' });
    pm.updateWorkItem(w.id, { status: 'done' });
    const md = pm.renderStatusReport(e.id);
    expect(md).toMatch(/ACME/);
    expect(md).toMatch(/100%|1\/1/);
    expect(md).toMatch(/work_item_added/);
    expect(md).toMatch(/work_item_updated/);
    expect(md).toMatch(/기록된 이벤트|미기록 진행 추정 없음/);
  });

  it('shows an AUDIT CHAIN BROKEN banner when the event chain is tampered', () => {
    const pm = createPmStore();
    const e = pm.createEngagement({ customer: 'A', product: 'IAG' });
    pm.appendPmEvent(e.id, 'diagnosis_run', { device: 'x' });
    pm.getEvents(e.id)[0].payload = { device: 'TAMPERED' };
    expect(pm.renderStatusReport(e.id)).toMatch(/AUDIT CHAIN BROKEN/i);
  });

  it('throws on an unknown engagement rather than rendering an empty report', () => {
    const pm = createPmStore();
    expect(() => pm.renderStatusReport('nope')).toThrow(/not found/i);
  });

  it('discloses when the audit chain is NOT cryptographically keyed (no false confidence)', () => {
    const pm = createPmStore(); // no secret → unkeyed
    const e = pm.createEngagement({ customer: 'A', product: 'IAG' });
    pm.appendPmEvent(e.id, 'diagnosis_run', { device: 'x' });
    expect(pm.renderStatusReport(e.id)).toMatch(/keyed|서명되지 않|키가 없|tamper-evidence/i);
  });

  it('does not show the unkeyed disclosure when a chain secret is configured', () => {
    const pm = createPmStore({ secret: 'audit-secret' });
    const e = pm.createEngagement({ customer: 'A', product: 'IAG' });
    pm.appendPmEvent(e.id, 'diagnosis_run', { device: 'x' });
    expect(pm.renderStatusReport(e.id)).not.toMatch(/서명되지 않은 감사 추적|NOT cryptographically keyed/i);
  });
});
