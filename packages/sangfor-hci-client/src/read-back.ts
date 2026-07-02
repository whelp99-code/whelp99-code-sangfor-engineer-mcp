import type { HciClient } from './client.js';
import { getVolume, listVolumes, type HciVolume } from './volumes.js';

// The read-back oracle: a create/change is only SUCCEEDED when an independent GET
// confirms it. A 2xx is never proof of effect (the official HCI doc notes a
// quota-exceeded extend still returns 202 while the volume stays unchanged).
// INDETERMINATE never counts as success.

export type ReadBackVerdict = 'PASS' | 'FAIL' | 'INDETERMINATE';
export interface ReadBackCheck { key: string; expected: unknown; observed: unknown; verdict: ReadBackVerdict; }
export interface ReadBackResult { verdict: ReadBackVerdict; checks: ReadBackCheck[]; reason?: string; volumeId?: string; }

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function readBackVolume(
  client: HciClient,
  expectation: { volumeId?: string; name: string; sizeGb: number },
  opts: { maxPolls?: number; pollIntervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<ReadBackResult> {
  const maxPolls = opts.maxPolls ?? 10;
  const pollIntervalMs = opts.pollIntervalMs ?? 1000;
  const sleep = opts.sleep ?? defaultSleep;

  let observed: HciVolume | null = null;
  try {
    if (expectation.volumeId) {
      observed = await getVolume(client, expectation.volumeId);
      if (!observed) {
        return { verdict: 'FAIL', checks: [], reason: `volume ${expectation.volumeId} not found — possible silent no-op (202 is not proof of effect)` };
      }
    } else {
      const matches = (await listVolumes(client)).filter((v) => v.name === expectation.name);
      if (matches.length === 0) return { verdict: 'FAIL', checks: [], reason: `no volume named '${expectation.name}' — possible silent no-op` };
      if (matches.length > 1) return { verdict: 'INDETERMINATE', checks: [], reason: `ambiguous: ${matches.length} volumes named '${expectation.name}' (cannot attribute; never PASS)` };
      observed = matches[0];
    }

    for (let poll = 0; observed.status === 'creating' && poll < maxPolls; poll += 1) {
      await sleep(pollIntervalMs);
      observed = await getVolume(client, observed.id);
      if (!observed) return { verdict: 'FAIL', checks: [], reason: 'volume disappeared while creating' };
    }
  } catch (error) {
    return { verdict: 'INDETERMINATE', checks: [], reason: `read-back error (never counts as pass): ${error instanceof Error ? error.message : String(error)}` };
  }

  if (observed.status === 'creating') {
    return { verdict: 'INDETERMINATE', checks: [], reason: `still 'creating' after ${maxPolls} polls`, volumeId: observed.id };
  }
  if (observed.status.startsWith('error')) {
    return { verdict: 'FAIL', checks: [], reason: `volume status '${observed.status}'`, volumeId: observed.id };
  }

  const checks: ReadBackCheck[] = [
    { key: 'status', expected: 'available', observed: observed.status, verdict: observed.status === 'available' ? 'PASS' : 'FAIL' },
    { key: 'name', expected: expectation.name, observed: observed.name, verdict: observed.name === expectation.name ? 'PASS' : 'FAIL' },
    { key: 'sizeGb', expected: expectation.sizeGb, observed: observed.size, verdict: observed.size === expectation.sizeGb ? 'PASS' : 'FAIL' },
  ];
  const verdict: ReadBackVerdict = checks.every((c) => c.verdict === 'PASS') ? 'PASS' : 'FAIL';
  return { verdict, checks, volumeId: observed.id, ...(verdict === 'FAIL' ? { reason: 'read-back values differ from the intent' } : {}) };
}
