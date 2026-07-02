import { createHash, createHmac } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRepoData } from '@sangfor/shared';

// Masked, append-only JSONL ledger with a hash chain. Every HCI change request,
// response, state transition, and verdict is recorded with secrets masked. When
// SANGFOR_CHANGE_LEDGER_SECRET is set the chain is keyed (tamper-evident); without
// it the chain is unkeyed and verify() says so (honest, like the PM audit chain).

const SECRET_KEY_RE = /password|secret|token|authorization|cookie/i;

export function maskSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => maskSecrets(v)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) && typeof v === 'string' ? '***' : maskSecrets(v);
    }
    return out as unknown as T;
  }
  return value;
}

export type LedgerKind = 'request' | 'response' | 'state' | 'verdict';

interface LedgerLine { seq: number; at: string; runId: string; kind: LedgerKind; payload: unknown; prevHash: string; hash: string; keyed: boolean; }

function digest(secret: string | undefined, prevHash: string, seq: number, kind: string, payload: unknown): string {
  const material = `${prevHash}\n${seq}\n${kind}\n${JSON.stringify(payload)}`;
  return secret ? createHmac('sha256', secret).update(material).digest('hex') : createHash('sha256').update(material).digest('hex');
}

export class AuditLedger {
  private readonly dir: string;
  private readonly secret: string | undefined;

  constructor(opts: { dir?: string; secret?: string } = {}) {
    this.dir = opts.dir ?? join(resolveRepoData('data/evidence'), 'change-runs');
    this.secret = opts.secret ?? process.env.SANGFOR_CHANGE_LEDGER_SECRET;
  }

  pathFor(runId: string): string { return join(this.dir, `${runId}.jsonl`); }

  private readLines(runId: string): LedgerLine[] {
    try {
      return readFileSync(this.pathFor(runId), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as LedgerLine);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  append(runId: string, kind: LedgerKind, payload: unknown): void {
    mkdirSync(this.dir, { recursive: true });
    const prior = this.readLines(runId);
    const seq = prior.length;
    const prevHash = prior.length ? prior[prior.length - 1].hash : 'GENESIS';
    const masked = maskSecrets(payload);
    const line: LedgerLine = {
      seq, at: new Date().toISOString(), runId, kind, payload: masked,
      prevHash, hash: digest(this.secret, prevHash, seq, kind, masked), keyed: Boolean(this.secret),
    };
    appendFileSync(this.pathFor(runId), `${JSON.stringify(line)}\n`);
  }

  verify(runId: string): { ok: boolean; keyed: boolean; brokenAt?: number } {
    const lines = this.readLines(runId);
    const keyed = lines.every((l) => l.keyed) && Boolean(this.secret);
    let prevHash = 'GENESIS';
    for (const [i, line] of lines.entries()) {
      const expected = digest(this.secret, prevHash, line.seq, line.kind, line.payload);
      if (line.seq !== i || line.prevHash !== prevHash || line.hash !== expected) {
        return { ok: false, keyed, brokenAt: i };
      }
      prevHash = line.hash;
    }
    return { ok: true, keyed };
  }
}
