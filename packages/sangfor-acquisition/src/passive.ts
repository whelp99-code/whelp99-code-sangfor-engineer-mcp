/**
 * Passive collection channel (design 002, block C1).
 *
 * Syslog / SNMP-trap-forwarder / webhook lines arrive as text from a transport
 * the CALLER owns — this module opens no socket and starts no server. It only
 * parses a line into a typed event and folds that event into a re-collection
 * queue, so passive intake stays pure, testable and replayable from a ledger.
 *
 * Safety principle: an unparseable line yields null. A guessed device or a
 * back-dated timestamp would trigger collection against the wrong box, so the
 * parser refuses rather than inventing. A parsed event whose hint matches no
 * registered device is recorded as unmatched — never silently dropped.
 */

export type PassiveSeverity = 'info' | 'warning' | 'error' | 'critical';

/** Known kinds; anything recognisable as an event but not classifiable stays 'unclassified'. */
export type PassiveEventKind =
  | 'ha-state-change'
  | 'link-down'
  | 'interface-flap'
  | 'cluster-membership-change'
  | 'vpn-tunnel-change'
  | 'resource-threshold'
  | 'unclassified';

export interface PassiveEvent {
  /** Hostname or address as reported by the device — resolved against the registry later. */
  deviceHint: string;
  eventKind: PassiveEventKind;
  severity: PassiveSeverity;
  /** ISO-8601 instant the device reported, never the receive time. */
  at: string;
}

export interface DeviceRegistry {
  byHostname?: Record<string, string>;
  byAddress?: Record<string, string>;
}

export interface RecollectEntry {
  deviceId: string;
  eventKind: PassiveEventKind;
  severity: PassiveSeverity;
  /** Instant of the FIRST event that opened this entry — the freshness deadline. */
  requestedAt: string;
  occurrences: number;
}

export interface UnmatchedPassiveEvent {
  deviceHint: string;
  eventKind: PassiveEventKind;
  severity: PassiveSeverity;
  at: string;
  reason: 'unknown-device-hint';
}

export interface RecollectQueue {
  entries: readonly RecollectEntry[];
  unmatched: readonly UnmatchedPassiveEvent[];
}

export interface EnqueueOptions {
  /** Injected collapse window: same device + kind inside it is one re-collection. */
  dedupeWindowMs: number;
}

const SEVERITY_RANK: Record<PassiveSeverity, number> = { info: 0, warning: 1, error: 2, critical: 3 };

/** RFC 5424 severity (priority % 8) folded onto our four-step ladder. */
function severityFromPriority(priority: number): PassiveSeverity {
  const code = priority % 8;
  if (code <= 2) return 'critical';
  if (code === 3) return 'error';
  if (code === 4) return 'warning';
  return 'info';
}

function normalizeSeverity(raw: unknown): PassiveSeverity {
  return typeof raw === 'string' && raw in SEVERITY_RANK ? (raw as PassiveSeverity) : 'info';
}

const KIND_PATTERNS: Array<{ kind: PassiveEventKind; re: RegExp }> = [
  { kind: 'ha-state-change', re: /\bha\b.*\b(state|failover|switchover|standby|active)\b/i },
  { kind: 'link-down', re: /\blink[\s_-]?down\b/i },
  { kind: 'interface-flap', re: /\b(interface|port)\b.*\bflap/i },
  { kind: 'cluster-membership-change', re: /\bcluster\b.*\b(member|join|leave|quorum)\b/i },
  { kind: 'vpn-tunnel-change', re: /\b(vpn|tunnel|ipsec)\b.*\b(up|down|rekey|peer)\b/i },
  { kind: 'resource-threshold', re: /\b(cpu|memory|disk|storage)\b.*\b(threshold|usage|high)\b/i },
];

/** Classify free text; an exact kind token from a webhook is honoured verbatim first. */
function classifyKind(text: string): PassiveEventKind {
  for (const { kind, re } of KIND_PATTERNS) if (re.test(text)) return kind;
  return 'unclassified';
}

function isKnownKind(raw: unknown): raw is PassiveEventKind {
  return typeof raw === 'string' && KIND_PATTERNS.some((p) => p.kind === raw);
}

/** ISO-8601 only; a locale/relative string is not a trustworthy device clock reading. */
function normalizeInstant(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(trimmed)) return null;
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

const SYSLOG_RE = /^<(\d{1,3})>\d?\s*(\S+)\s+(\S+)\s+(.*)$/;

function parseSyslog(line: string): PassiveEvent | null {
  const match = SYSLOG_RE.exec(line);
  if (!match) return null;
  const [, priorityRaw, timestampRaw, hostRaw, rest] = match;
  const at = normalizeInstant(timestampRaw);
  if (at === null || hostRaw === undefined || hostRaw === '-') return null;
  return {
    deviceHint: hostRaw,
    eventKind: classifyKind(rest ?? ''),
    severity: severityFromPriority(Number(priorityRaw)),
    at,
  };
}

function parseWebhook(line: string): PassiveEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const hint = firstString(record, ['host', 'hostname', 'device', 'deviceHint', 'source', 'ip', 'address']);
  const at = normalizeInstant(firstString(record, ['timestamp', 'at', 'time', 'eventTime']));
  if (typeof hint !== 'string' || at === null) return null;
  const kindRaw = firstString(record, ['event', 'eventKind', 'kind', 'type']);
  const message = firstString(record, ['message', 'msg', 'description']);
  const kind = isKnownKind(kindRaw)
    ? kindRaw
    : classifyKind([typeof kindRaw === 'string' ? kindRaw : '', typeof message === 'string' ? message : ''].join(' '));
  return { deviceHint: hint, eventKind: kind, severity: normalizeSeverity(record.severity), at };
}

/**
 * Parse one passive line (syslog-shaped or JSON webhook-shaped). Returns null
 * when the line cannot be trusted to identify a device and an instant.
 */
export function parsePassiveEvent(line: string): PassiveEvent | null {
  if (typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (trimmed === '') return null;
  return trimmed.startsWith('{') ? parseWebhook(trimmed) : parseSyslog(trimmed);
}

function resolveDeviceId(hint: string, registry: DeviceRegistry): string | undefined {
  const byAddress = registry.byAddress?.[hint];
  if (byAddress !== undefined) return byAddress;
  const hostnames = registry.byHostname ?? {};
  const direct = hostnames[hint];
  if (direct !== undefined) return direct;
  const lowered = hint.toLowerCase();
  const found = Object.entries(hostnames).find(([name]) => name.toLowerCase() === lowered);
  return found?.[1];
}

/**
 * Fold a passive event into the re-collection queue. Pure: returns a new queue,
 * never mutating the input. Repeats of the same device+kind inside the injected
 * window collapse into one entry (occurrence counted, severity escalated to the
 * worst seen) so an event storm cannot multiply the load on a struggling device.
 */
export function enqueueTargetedRecollect(
  queue: RecollectQueue,
  event: PassiveEvent,
  registry: DeviceRegistry,
  options: EnqueueOptions,
): RecollectQueue {
  const deviceId = resolveDeviceId(event.deviceHint, registry);
  if (deviceId === undefined) {
    const unmatched: UnmatchedPassiveEvent = {
      deviceHint: event.deviceHint,
      eventKind: event.eventKind,
      severity: event.severity,
      at: event.at,
      reason: 'unknown-device-hint',
    };
    return { entries: [...queue.entries], unmatched: [...queue.unmatched, unmatched] };
  }

  const eventMs = Date.parse(event.at);
  const index = queue.entries.findIndex((entry) => {
    if (entry.deviceId !== deviceId || entry.eventKind !== event.eventKind) return false;
    const openedMs = Date.parse(entry.requestedAt);
    if (Number.isNaN(openedMs) || Number.isNaN(eventMs)) return false;
    return Math.abs(eventMs - openedMs) <= options.dedupeWindowMs;
  });

  if (index === -1) {
    const entry: RecollectEntry = {
      deviceId,
      eventKind: event.eventKind,
      severity: event.severity,
      requestedAt: event.at,
      occurrences: 1,
    };
    return { entries: [...queue.entries, entry], unmatched: [...queue.unmatched] };
  }

  const existing = queue.entries[index] as RecollectEntry;
  const merged: RecollectEntry = {
    ...existing,
    severity: SEVERITY_RANK[event.severity] > SEVERITY_RANK[existing.severity] ? event.severity : existing.severity,
    occurrences: existing.occurrences + 1,
  };
  const entries = [...queue.entries];
  entries[index] = merged;
  return { entries, unmatched: [...queue.unmatched] };
}
