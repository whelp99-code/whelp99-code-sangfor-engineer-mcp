import { nowId } from '@sangfor/shared';
import type { HciClient } from './client.js';
import { createVolume, type CreateVolumeInput } from './volumes.js';
import { readBackVolume, type ReadBackResult } from './read-back.js';
import type { AuditLedger } from './audit-ledger.js';

// PENDING → VALIDATING → APPLYING → VERIFYING → SUCCEEDED | FAILED_HALT.
// Invariants: a 2xx is never success (only a PASS read-back is); FAILED_HALT never
// auto-rolls-back (a human is called); every step is written to the audit ledger.

export type ApplyState = 'PENDING' | 'VALIDATING' | 'APPLYING' | 'VERIFYING' | 'SUCCEEDED' | 'FAILED_HALT';
export interface ApplyEvent { at: string; state: ApplyState; detail: string; }
export interface ApplyCreateVolumeInput extends CreateVolumeInput { clientToken: string; }
export interface ApplyResult { ok: boolean; finalState: ApplyState; runId: string; volumeId?: string; readBack?: ReadBackResult; events: ApplyEvent[]; }
export interface ApplyOptions { maxPolls?: number; pollIntervalMs?: number; sleep?: (ms: number) => Promise<void>; extraCreateHeaders?: Record<string, string>; }

// True if the string contains any ASCII control character (log/inject safety).
// Ordinary punctuation such as hyphens is allowed.
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

export function validateCreateVolumeInput(input: ApplyCreateVolumeInput): string[] {
  const problems: string[] = [];
  if (!input.name || input.name.length > 64 || hasControlChar(input.name)) problems.push('name must be 1..64 chars without control characters');
  if (!Number.isInteger(input.sizeGb) || input.sizeGb < 1 || input.sizeGb > 65536) problems.push('sizeGb must be an integer in 1..65536');
  if (!input.clientToken || input.clientToken.length < 8) problems.push('clientToken (idempotency key) must be at least 8 chars');
  return problems;
}

export async function applyCreateVolume(
  client: HciClient,
  input: ApplyCreateVolumeInput,
  ledger: AuditLedger,
  opts: ApplyOptions = {},
): Promise<ApplyResult> {
  const runId = nowId('hci_apply');
  const events: ApplyEvent[] = [];
  const step = (state: ApplyState, detail: string) => {
    const ev: ApplyEvent = { at: new Date().toISOString(), state, detail };
    events.push(ev);
    ledger.append(runId, 'state', ev);
  };
  const halt = (detail: string, extra: Partial<ApplyResult> = {}): ApplyResult => {
    step('FAILED_HALT', `${detail} — halting for human review (no auto-rollback)`);
    return { ok: false, finalState: 'FAILED_HALT', runId, events, ...extra };
  };

  step('PENDING', `create-volume '${input.name}' (${input.sizeGb}GB)`);

  step('VALIDATING', 'input validation');
  const problems = validateCreateVolumeInput(input);
  if (problems.length) return halt(`validation failed: ${problems.join('; ')}`);

  step('APPLYING', 'POST /volumes with X-Client-Token idempotency');
  ledger.append(runId, 'request', { op: 'create-volume', name: input.name, sizeGb: input.sizeGb, description: input.description ?? null, clientToken: input.clientToken });
  let created: Awaited<ReturnType<typeof createVolume>>;
  try {
    created = await createVolume(client, input, input.clientToken, opts.extraCreateHeaders);
  } catch (error) {
    return halt(`create request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  ledger.append(runId, 'response', { status: created.status, volume: created.volume });
  if (created.status !== 202 && created.status !== 200) return halt(`unexpected HTTP ${created.status} from create`);

  // A 2xx alone is NEVER success (official doc: quota-exceeded ops still return 202
  // with no effect). The read-back oracle is the only success signal.
  step('VERIFYING', 'independent GET read-back');
  const readBack = await readBackVolume(client, { volumeId: created.volume?.id, name: input.name, sizeGb: input.sizeGb }, opts);
  ledger.append(runId, 'verdict', readBack);

  if (readBack.verdict === 'PASS') {
    step('SUCCEEDED', `volume ${readBack.volumeId} verified by read-back`);
    return { ok: true, finalState: 'SUCCEEDED', runId, volumeId: readBack.volumeId, readBack, events };
  }
  return halt(`read-back ${readBack.verdict}: ${readBack.reason ?? 'values differ from intent'}`, { volumeId: created.volume?.id, readBack });
}
