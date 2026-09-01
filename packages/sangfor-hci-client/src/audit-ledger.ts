import { createHash, createHmac } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expectedLocalWriteScope, requireLocalWriteAuthority, resolveEngagementScopedData, withDirLock, type LocalWriteAuthority } from '@sangfor/shared';
import { RuntimeSchemaError } from '../../shared/src/runtime-schema.js';
import { parseBoundaryHciAuditLineV1 } from './runtime-boundaries.js';

// Masked, append-only JSONL ledger with a hash chain. Every HCI change request,
// response, state transition, and verdict is recorded with secrets masked. When
// SANGFOR_CHANGE_LEDGER_SECRET is set the chain is keyed (tamper-evident); without
// it the chain is unkeyed and verify() says so (honest, like the PM audit chain).

const SECRET_KEY_RE = /password|secret|token|authorization|cookie/i;

export function assertLocalAuditAuthorityAllowed(): void {
  if (process.env.SANGFOR_BLRO_AUTHORITY_STORE === 'postgres') {
    throw new Error('JM_LOCAL_AUDIT_SUPERSEDED: use BlroAuthorityStore');
  }
}

export function maskSecrets<T>(value: T): T;
export function maskSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => maskSecrets(item));
  if (value !== null && typeof value === 'object') {
    const masked: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      masked[key] = SECRET_KEY_RE.test(key) && typeof child === 'string'
        ? '***'
        : maskSecrets(child);
    }
    return masked;
  }
  return value;
}

export type LedgerKind = 'request' | 'response' | 'state' | 'verdict';

export interface LedgerLine { seq: number; at: string; runId: string; kind: LedgerKind; payload: unknown; prevHash: string; hash: string; keyed: boolean; }

function digest(secret: string | undefined, prevHash: string, seq: number, kind: string, payload: unknown): string {
  const material = `${prevHash}\n${seq}\n${kind}\n${JSON.stringify(payload)}`;
  return secret ? createHmac('sha256', secret).update(material).digest('hex') : createHash('sha256').update(material).digest('hex');
}

export class AuditLedger {
  private readonly dir: string;
  private readonly secret: string | undefined;
  private readonly authority: LocalWriteAuthority;

  constructor(opts: { dir?: string; secret?: string; authority: LocalWriteAuthority }) {
    // Engagement-scoped: change-run audit lines are per-project evidence, so an
    // unscoped root would pool several projects' audit chains in one partition.
    this.dir = opts.dir ?? join(resolveEngagementScopedData('data/evidence', 'SANGFOR_EVIDENCE_ROOT'), 'change-runs');
    this.secret = opts.secret ?? process.env.SANGFOR_CHANGE_LEDGER_SECRET;
    this.authority = requireLocalWriteAuthority(opts.authority, expectedLocalWriteScope(
      opts.authority, opts.authority?.projectId ?? '', 'audit', this.dir,
    ));
  }

  pathFor(runId: string): string { return join(this.dir, `${runId}.jsonl`); }

  private readLines(runId: string): LedgerLine[] {
    try {
      return readFileSync(this.pathFor(runId), 'utf8').trim().split('\n').filter(Boolean).map((line) => parseBoundaryHciAuditLineV1(line));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async append(runId: string, kind: LedgerKind, payload: unknown): Promise<void> {
    await this.authority.fence.write(this.authority, { operation: `audit.append:${kind}`, targetPaths: [this.pathFor(runId)] }, () => {
      mkdirSync(this.dir, { recursive: true });
    // The hash chain reads the prior line's hash before computing this line's
    // hash — two concurrent appends to the same run would otherwise both read
    // the same "prior" tail and each produce a line claiming the same prevHash,
    // breaking the chain's linearity. Lock the whole read-then-append.
    withDirLock(`${this.pathFor(runId)}.lock`, () => {
      const prior = this.readLines(runId);
      const seq = prior.length;
      const prevHash = prior.length ? prior[prior.length - 1].hash : 'GENESIS';
      const masked = maskSecrets(payload);
      const line: LedgerLine = {
        seq, at: new Date().toISOString(), runId, kind, payload: masked,
        prevHash, hash: digest(this.secret, prevHash, seq, kind, masked), keyed: Boolean(this.secret),
      };
      appendFileSync(this.pathFor(runId), `${JSON.stringify(line)}\n`);
      });
    });
  }

  verify(runId: string): { ok: boolean; keyed: boolean; brokenAt?: number } {
    let lines: LedgerLine[];
    try {
      lines = this.readLines(runId);
    } catch (error) {
      if (!(error instanceof RuntimeSchemaError)) throw error;
      return { ok: false, keyed: false, brokenAt: 0 };
    }
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
