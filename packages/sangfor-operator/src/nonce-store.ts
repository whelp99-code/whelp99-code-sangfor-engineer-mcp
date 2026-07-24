import { join } from 'node:path';
import { FileSingleUseNonceStore } from '@sangfor/approval';
import { resolveRepoData } from '@sangfor/shared';

// Durable single-use store for live-execution approval nonces (closes redteam R1:
// replay of a verified (action, nonce, expiresAt) tuple within its expiry window).
// Fail-closed: any storage error refuses consumption, which refuses execution.

export interface NonceConsumeResult { ok: boolean; reason?: string; }

export function defaultNonceStorePath(): string {
  return process.env.SANGFOR_NONCE_STORE_PATH ?? join(resolveRepoData('data/runtime'), 'approval-nonces.json');
}

export class FileNonceStore {
  private readonly sharedStore: FileSingleUseNonceStore;

  constructor(filePath: string = defaultNonceStorePath()) {
    this.sharedStore = new FileSingleUseNonceStore(filePath);
  }

  consume(nonce: string, expiresAt: string, now: Date = new Date()): NonceConsumeResult {
    const result = this.sharedStore.consume(nonce, expiresAt, now);
    if (result.ok || result.reason?.startsWith('approval nonce already used:')) return result;
    return { ok: false, reason: `nonce store unavailable (fail-closed): ${result.reason ?? 'unknown store error'}` };
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
