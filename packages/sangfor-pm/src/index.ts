/**
 * @sangfor/pm — PM data skeleton (non-destructive): Engagement / WorkItem /
 * tamper-evident PmEvent (hash chain) / DeviceOccupancy lock (shared-device safety).
 *
 * This is the data layer the PM-agent tier needs BEFORE any auto-dispatch: the
 * device lock prevents one engagement's change from landing on a device another
 * engagement is actively using (the shared-lab disaster the addendum flagged).
 */
import { createHash } from 'node:crypto';

export type WorkStatus = 'todo' | 'in_progress' | 'blocked' | 'done';

export interface Engagement { id: string; customer: string; product: string; status: string; createdAt: string; }
export interface WorkItem { id: string; engagementId: string; title: string; status: WorkStatus; deviceId?: string; assignee?: string; }
export interface PmEvent { id: string; seq: number; engagementId: string; type: string; payload: unknown; prevHash: string; hash: string; }
export interface DeviceLock { deviceId: string; engagementId: string; holder: string; acquiredAt: string; }

export interface StatusRollup { total: number; todo: number; in_progress: number; blocked: number; done: number; percentDone: number; }

function hashEvent(prevHash: string, seq: number, type: string, payload: unknown): string {
  return createHash('sha256').update(`${prevHash}|${seq}|${type}|${JSON.stringify(payload ?? null)}`).digest('hex');
}

export function createPmStore() {
  const engagements = new Map<string, Engagement>();
  const workItems = new Map<string, WorkItem>();
  const events = new Map<string, PmEvent[]>();       // engagementId → chain
  const chainMeta = new Map<string, { count: number; head: string }>(); // independent length/tip anchor
  const locks = new Map<string, DeviceLock>();       // deviceId → lock
  let n = 0;
  const id = (p: string) => `${p}_${++n}`;

  const append = (engagementId: string, type: string, payload: unknown): PmEvent => {
    const chain = events.get(engagementId) ?? [];
    const seq = chain.length + 1;
    const prevHash = chain.length ? chain[chain.length - 1].hash : 'GENESIS';
    const ev: PmEvent = { id: id('ev'), seq, engagementId, type, payload, prevHash, hash: hashEvent(prevHash, seq, type, payload) };
    chain.push(ev);
    events.set(engagementId, chain);
    // Anchor the authoritative length + tip so tail truncation of the array is detectable.
    chainMeta.set(engagementId, { count: chain.length, head: ev.hash });
    return ev;
  };

  // Verify structure + contiguity + independent length/tip anchor.
  const verifyChain = (engagementId: string): { ok: boolean; brokenAt?: number } => {
    const chain = events.get(engagementId) ?? [];
    let prevHash = 'GENESIS';
    for (let i = 0; i < chain.length; i++) {
      const ev = chain[i];
      if (ev.seq !== i + 1) return { ok: false, brokenAt: ev.seq };          // reorder / gap
      if (ev.prevHash !== prevHash) return { ok: false, brokenAt: ev.seq };
      if (ev.hash !== hashEvent(prevHash, ev.seq, ev.type, ev.payload)) return { ok: false, brokenAt: ev.seq };
      prevHash = ev.hash;
    }
    const meta = chainMeta.get(engagementId);
    if (meta && (chain.length !== meta.count || (chain.length > 0 && chain[chain.length - 1].hash !== meta.head))) {
      return { ok: false, brokenAt: chain.length }; // tail truncation / append-array tamper
    }
    return { ok: true };
  };

  return {
    createEngagement(input: { customer: string; product: string }): Engagement {
      const e: Engagement = { id: id('eng'), customer: input.customer, product: input.product, status: 'active', createdAt: new Date().toISOString() };
      engagements.set(e.id, e);
      events.set(e.id, []);
      return e;
    },
    addWorkItem(engagementId: string, input: { title: string; deviceId?: string; assignee?: string }): WorkItem {
      if (!engagements.has(engagementId)) throw new Error(`Engagement not found: ${engagementId}`);
      const w: WorkItem = { id: id('wi'), engagementId, title: input.title, status: 'todo', deviceId: input.deviceId, assignee: input.assignee };
      workItems.set(w.id, w);
      append(engagementId, 'work_item_added', { workItemId: w.id, title: w.title });
      return w;
    },
    updateWorkItem(workItemId: string, patch: Partial<Pick<WorkItem, 'status' | 'deviceId' | 'assignee'>>): WorkItem {
      const w = workItems.get(workItemId);
      if (!w) throw new Error(`WorkItem not found: ${workItemId}`);
      const from = w.status;
      Object.assign(w, patch);
      // Every state transition/reassignment must leave an audit trace (symmetry with add).
      if (engagements.has(w.engagementId)) append(w.engagementId, 'work_item_updated', { workItemId, patch, from });
      return w;
    },
    getEngagement(engagementId: string): Engagement | undefined { return engagements.get(engagementId); },
    statusRollup(engagementId: string): StatusRollup {
      // Unknown id must not masquerade as an empty engagement (fake 0%) — be
      // consistent with addWorkItem and fail loudly.
      if (!engagements.has(engagementId)) throw new Error(`Engagement not found: ${engagementId}`);
      const items = [...workItems.values()].filter((w) => w.engagementId === engagementId);
      const by = (s: WorkStatus) => items.filter((w) => w.status === s).length;
      const total = items.length;
      const done = by('done');
      return { total, todo: by('todo'), in_progress: by('in_progress'), blocked: by('blocked'), done, percentDone: total ? (done / total) * 100 : 0 };
    },
    renderStatusReport(engagementId: string): string {
      if (!engagements.has(engagementId)) throw new Error(`Engagement not found: ${engagementId}`);
      const e = engagements.get(engagementId)!;
      const items = [...workItems.values()].filter((w) => w.engagementId === engagementId);
      const by = (s: WorkStatus) => items.filter((w) => w.status === s).length;
      const total = items.length;
      const done = by('done');
      const pct = total ? Math.round((done / total) * 100) : 0;
      const chain = events.get(engagementId) ?? [];
      // Disclose a broken audit trail (incl. tail truncation) rather than hide it.
      const v = verifyChain(engagementId);
      const broken = v.ok ? 0 : (v.brokenAt ?? 0);
      const lines: string[] = [`# PM 진행 보고 — ${e.customer} / ${e.product}`, ''];
      if (broken) lines.push(`> ⚠️ AUDIT CHAIN BROKEN at seq ${broken} — 이벤트 무결성 손상, 보고 신뢰 불가`, '');
      lines.push(
        `- 진행률: ${pct}% (${done}/${total} 완료)`,
        `- 상태: todo ${by('todo')} · 진행 ${by('in_progress')} · 블록 ${by('blocked')} · 완료 ${done}`,
        '', '## 작업 항목', '',
      );
      if (!items.length) lines.push('_없음_');
      for (const w of items) lines.push(`- [${w.status}] ${w.title}${w.deviceId ? ` (device: ${w.deviceId})` : ''}${w.assignee ? ` — ${w.assignee}` : ''}`);
      lines.push('', `## 이벤트 타임라인 (기록된 ${chain.length}건에서 도출)`, '');
      if (!chain.length) lines.push('_없음_');
      for (const ev of chain) lines.push(`- #${ev.seq} ${ev.type} — ${JSON.stringify(ev.payload)}`);
      lines.push('', '> 본 보고는 기록된 이벤트에서만 도출되었습니다(미기록 진행 추정 없음).', '');
      return lines.join('\n');
    },
    appendPmEvent(engagementId: string, type: string, payload: unknown): PmEvent { return append(engagementId, type, payload); },
    getEvents(engagementId: string): PmEvent[] { return events.get(engagementId) ?? []; },
    verifyEventChain(engagementId: string): { ok: boolean; brokenAt?: number } {
      return verifyChain(engagementId);
    },
    acquireDevice(deviceId: string, engagementId: string, holder: string): { ok: boolean; heldBy?: DeviceLock } {
      const existing = locks.get(deviceId);
      // Held by another engagement, OR by a different holder within the same
      // engagement (engineerB must not silently steal engineerA's lock) → fail-closed.
      if (existing && (existing.engagementId !== engagementId || existing.holder !== holder)) {
        return { ok: false, heldBy: existing };
      }
      // Idempotent re-acquire by the same holder: keep the ORIGINAL lock (do not reset
      // acquiredAt — occupancy age must not be silently refreshed) and emit no new event.
      if (existing) return { ok: true, heldBy: existing };
      const lock: DeviceLock = { deviceId, engagementId, holder, acquiredAt: new Date().toISOString() };
      locks.set(deviceId, lock);
      if (engagements.has(engagementId)) append(engagementId, 'device_acquired', { deviceId, holder, acquiredAt: lock.acquiredAt });
      return { ok: true, heldBy: lock };
    },
    releaseDevice(deviceId: string, engagementId: string): boolean {
      const existing = locks.get(deviceId);
      if (existing && existing.engagementId === engagementId) {
        locks.delete(deviceId);
        if (engagements.has(engagementId)) append(engagementId, 'device_released', { deviceId, holder: existing.holder });
        return true;
      }
      return false;
    },
    deviceOccupancy(): DeviceLock[] { return [...locks.values()]; },
    listEngagements(): Engagement[] { return [...engagements.values()]; },
  };
}
