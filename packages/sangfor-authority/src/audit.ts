import { createHash, createHmac } from 'node:crypto';

export interface AuditEventInput {
  readonly projectId: string;
  readonly seq: number;
  readonly kind: string;
  readonly payload: unknown;
  readonly prevHash: string;
  readonly actorId?: string;
  readonly at?: string;
}

export interface AuditEvent {
  readonly projectId: string;
  readonly seq: number;
  readonly kind: string;
  readonly payload: unknown;
  readonly prevHash: string;
  readonly actorId?: string;
  readonly at: string;
  readonly hash: string;
  readonly keyed: boolean;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function material(event: Omit<AuditEvent, 'hash' | 'keyed'>): string {
  return canonical({
    actorId: event.actorId ?? null,
    at: event.at,
    kind: event.kind,
    payload: event.payload,
    prevHash: event.prevHash,
    projectId: event.projectId,
    seq: event.seq,
  });
}

function digest(event: Omit<AuditEvent, 'hash' | 'keyed'>, secret?: string): string {
  return secret
    ? createHmac('sha256', secret).update(material(event)).digest('hex')
    : createHash('sha256').update(material(event)).digest('hex');
}

export function buildAuditEvent(input: AuditEventInput, secret?: string): AuditEvent {
  const base: Omit<AuditEvent, 'hash' | 'keyed'> = {
    projectId: input.projectId,
    seq: input.seq,
    kind: input.kind,
    payload: input.payload,
    prevHash: input.prevHash,
    at: input.at ?? new Date().toISOString(),
    ...(input.actorId ? { actorId: input.actorId } : {}),
  };
  return { ...base, hash: digest(base, secret), keyed: Boolean(secret) };
}

export function verifyAuditEvents(
  events: readonly AuditEvent[],
  secret?: string,
): { ok: boolean; keyed: boolean; brokenAt?: number } {
  const keyed = events.every((event) => event.keyed) && Boolean(secret);
  let previous = 'GENESIS';
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!event) return { ok: false, keyed, brokenAt: index };
    const { hash, keyed: eventKeyed, ...base } = event;
    if (event.seq !== index || event.prevHash !== previous || event.projectId !== events[0]?.projectId
      || eventKeyed !== Boolean(secret) || hash !== digest(base, secret)) {
      return { ok: false, keyed, brokenAt: index };
    }
    previous = hash;
  }
  return { ok: true, keyed };
}
