import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { MethodCode } from './methods.js';

/**
 * PR-001C: Atomic commit, lock/CAS/fsync, immutable revision store.
 */

export type StrategyState =
  | 'draft'
  | 'researched'
  | 'lab_verified'
  | 'device_verified'
  | 'strategy_field_verified'
  | 'stale'
  | 'deprecated';

export interface StrategyRevision {
  revisionId: string;
  strategyId: string;
  state: StrategyState;
  contentHash: string;
  derivedFromRevisionId?: string;
  createdAt: string;
  evidenceFile?: string;
  evidenceDigest?: string;
  methods?: MethodCode[];
}

export interface StrategyGeneration {
  generation: number;
  revisions: StrategyRevision[];
  contentHash: string;
}

export interface StrategyStore {
  strategyId: string;
  generations: StrategyGeneration[];
  currentGeneration: number;
}

const LOCK_WAIT_MS = 2_000;

function monotonicNowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function pause(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function acquireLock(lockPath: string): void {
  const deadline = monotonicNowMs() + LOCK_WAIT_MS;
  while (true) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      chmodSync(lockPath, 0o700);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const remaining = deadline - monotonicNowMs();
      if (remaining <= 0) throw new Error('STORE_LOCK_TIMEOUT');
      pause(Math.min(25, remaining));
    }
  }
}

function syncParentDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function writeFileAtomic(filePath: string, content: string): void {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(tempPath, 'wx', 0o600);
  try {
    const bytes = Buffer.from(content, 'utf8');
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset, null);
    fsyncSync(fd);
    chmodSync(tempPath, 0o600);
  } finally {
    closeSync(fd);
  }
  renameSync(tempPath, filePath);
  syncParentDirectory(dirname(filePath));
}

export function computeContentHash(revisions: StrategyRevision[]): string {
  const canonical = JSON.stringify(revisions, Object.keys(revisions[0] ?? {}).sort());
  return createHash('sha256').update(canonical).digest('hex');
}

export class StrategyStoreManager {
  constructor(private readonly storePath: string) {}

  load(): StrategyStore | null {
    if (!existsSync(this.storePath)) return null;
    try {
      const content = readFileSync(this.storePath, 'utf8');
      return JSON.parse(content) as StrategyStore;
    } catch {
      return null; // Corrupt generation fail-closed
    }
  }

  commit(store: StrategyStore, expectedGeneration: number): { ok: boolean; error?: string } {
    const lockPath = `${this.storePath}.lock`;
    let lockAcquired = false;
    try {
      mkdirSync(dirname(this.storePath), { recursive: true });
      acquireLock(lockPath);
      lockAcquired = true;

      // CAS: Compare-and-swap with expected generation
      const current = this.load();
      const currentGen = current?.currentGeneration ?? 0;
      if (currentGen !== expectedGeneration) {
        return { ok: false, error: `GENERATION_CONFLICT: expected ${expectedGeneration}, got ${currentGen}` };
      }

      // Immutable revision: append-only
      const newGeneration: StrategyGeneration = {
        generation: currentGen + 1,
        revisions: store.generations.flatMap(g => g.revisions),
        contentHash: computeContentHash(store.generations.flatMap(g => g.revisions)),
      };

      const updatedStore: StrategyStore = {
        ...store,
        generations: [...store.generations, newGeneration],
        currentGeneration: currentGen + 1,
      };

      writeFileAtomic(this.storePath, JSON.stringify(updatedStore, null, 2));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (lockAcquired) {
        try { rmdirSync(lockPath); } catch { /* leave failed lock fail-closed */ }
      }
    }
  }

  createStrategy(strategyId: string): StrategyStore {
    return {
      strategyId,
      generations: [],
      currentGeneration: 0,
    };
  }

  addRevision(store: StrategyStore, revision: Omit<StrategyRevision, 'revisionId' | 'createdAt'>): StrategyStore {
    const newRevision: StrategyRevision = {
      ...revision,
      revisionId: randomUUID(),
      createdAt: new Date().toISOString(),
    };

    const newGeneration: StrategyGeneration = {
      generation: store.currentGeneration + 1,
      revisions: [newRevision],
      contentHash: computeContentHash([newRevision]),
    };

    return {
      ...store,
      generations: [...store.generations, newGeneration],
      currentGeneration: store.currentGeneration + 1,
    };
  }
}
