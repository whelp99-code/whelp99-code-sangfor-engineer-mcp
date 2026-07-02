import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveRepoData } from '@sangfor/shared';

// Durable single-use store for live-execution approval nonces (closes redteam R1:
// replay of a verified (action, nonce, expiresAt) tuple within its expiry window).
// Fail-closed: any storage error refuses consumption, which refuses execution.

export interface NonceConsumeResult { ok: boolean; reason?: string; }

interface StoreShape { consumed: Array<{ nonce: string; expiresAt: string; consumedAt: string }>; }

export function defaultNonceStorePath(): string {
  return process.env.SANGFOR_NONCE_STORE_PATH ?? join(resolveRepoData('data/runtime'), 'approval-nonces.json');
}

export class FileNonceStore {
  constructor(private readonly filePath: string = defaultNonceStorePath()) {}

  consume(nonce: string, expiresAt: string, now: Date = new Date()): NonceConsumeResult {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const state = this.load();
      const live = state.consumed.filter((r) => new Date(r.expiresAt).getTime() >= now.getTime());
      if (live.some((r) => r.nonce === nonce)) {
        return { ok: false, reason: `approval nonce already used: ${nonce}` };
      }
      live.push({ nonce, expiresAt, consumedAt: now.toISOString() });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ consumed: live }, null, 2));
      renameSync(tmp, this.filePath);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: `nonce store unavailable (fail-closed): ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private load(): StoreShape {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as StoreShape;
      if (!parsed || !Array.isArray(parsed.consumed)) throw new Error('nonce store shape invalid');
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { consumed: [] };
      throw error; // corrupt store must fail closed, not silently reset
    }
  }
}

let sharedStore: FileNonceStore | null = null;
let sharedStorePath: string | null = null;

export function consumeApprovalNonce(approval: { nonce: string; expiresAt: string }, now?: Date): NonceConsumeResult {
  const path = defaultNonceStorePath();
  if (!sharedStore || sharedStorePath !== path) {
    sharedStore = new FileNonceStore(path);
    sharedStorePath = path;
  }
  return sharedStore.consume(approval.nonce, approval.expiresAt, now);
}
