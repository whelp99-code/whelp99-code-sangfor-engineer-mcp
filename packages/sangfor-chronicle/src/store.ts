/**
 * Content-addressed config snapshot store (design 002, block B1).
 *
 * One append-only chain per deviceId, persisted as a single JSON file under the
 * caller-supplied dir. Each node's hash is sha256 over the canonical preimage
 * (recursively sorted keys, ephemeral keys excluded), so an unchanged device
 * re-records to the same address and creates no node — the chain grows only on
 * real semantic drift. Every node carries the write-time diff against its
 * parent so readers never have to recompute history.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { expectedLocalWriteScope, requireLocalWriteAuthority, writeFileAtomicSync, withDirLock, type LocalWriteAuthority } from '@sangfor/shared';
import { canonicalize, parseCanonical, semanticDiff, type SemanticChange } from './diff.js';

export interface ChronicleSnapshot {
  hash: string;
  parentHash?: string;
  deviceId: string;
  capturedAt: string;
  /** Full observation as captured, including ephemeral keys (not hashed). */
  observed: Record<string, unknown>;
  /** Sorted list of keys excluded from the content address. */
  ephemeralKeys: string[];
  /** Canonical JSON preimage — sha256 of this string is `hash`. */
  canonical: string;
  /** Semantic diff against `parentHash`, computed once at write time. */
  diff: SemanticChange[];
}

export interface ChronicleChain {
  deviceId: string;
  headHash?: string;
  snapshots: ChronicleSnapshot[];
}

export interface RecordSnapshotInput {
  deviceId: string;
  observed: Record<string, unknown>;
  ephemeralKeys?: readonly string[];
  capturedAt: string;
  dir: string;
  authority: LocalWriteAuthority;
}

export interface RecordSnapshotResult {
  /** False when the state was unchanged (or differed only in ephemeral keys). */
  created: boolean;
  hash: string;
  parentHash?: string;
  snapshot: ChronicleSnapshot;
}

const DEVICE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/u;

function assertDeviceId(deviceId: string): void {
  // A deviceId becomes a filename; anything that could traverse or collide must
  // fail loud rather than write outside the caller's store directory.
  if (deviceId === '.' || deviceId === '..' || !DEVICE_ID_RE.test(deviceId)) {
    throw new Error(`Invalid deviceId "${deviceId}": must match ${DEVICE_ID_RE.source}`);
  }
}

function chainPath(deviceId: string, dir: string): string {
  return join(dir, `${deviceId}.json`);
}

function readChain(deviceId: string, dir: string): ChronicleChain {
  const path = chainPath(deviceId, dir);
  if (!existsSync(path)) return { deviceId, snapshots: [] };
  return JSON.parse(readFileSync(path, 'utf8')) as ChronicleChain;
}

/**
 * Append `observed` to the device's chain if — and only if — its canonical form
 * differs from the current head. Read-modify-write runs under a per-device
 * directory lock and the chain file is replaced atomically.
 */
export async function recordSnapshot(input: RecordSnapshotInput): Promise<RecordSnapshotResult> {
  const { deviceId, observed, capturedAt, dir } = input;
  assertDeviceId(deviceId);
  const ephemeralKeys = [...new Set(input.ephemeralKeys ?? [])].sort();
  const canonical = canonicalize(observed, ephemeralKeys);
  const hash = createHash('sha256').update(canonical).digest('hex');

  const authority = requireLocalWriteAuthority(input.authority, expectedLocalWriteScope(
    input.authority, input.authority?.projectId ?? '', 'config_chronicle_state', dir,
  ));
  return authority.fence.write(authority, { operation: 'chronicle.record-snapshot', targetPaths: [chainPath(deviceId, dir)] }, () => withDirLock(join(dir, `${deviceId}.lock`), () => {
    const chain = readChain(deviceId, dir);
    const head = chain.snapshots.at(-1);
    if (head && head.hash === hash) {
      return { created: false, hash: head.hash, parentHash: head.parentHash, snapshot: head };
    }

    const snapshot: ChronicleSnapshot = {
      hash,
      ...(head ? { parentHash: head.hash } : {}),
      deviceId,
      capturedAt,
      observed,
      ephemeralKeys,
      canonical,
      diff: semanticDiff(head ? parseCanonical(head.canonical) : {}, parseCanonical(canonical)),
    };
    const next: ChronicleChain = {
      deviceId,
      headHash: hash,
      snapshots: [...chain.snapshots, snapshot],
    };
    writeFileAtomicSync(chainPath(deviceId, dir), `${JSON.stringify(next, null, 2)}\n`);
    return { created: true, hash, parentHash: snapshot.parentHash, snapshot };
  }));
}

/** The device's newest snapshot, or undefined when it has no chain yet. */
export function getHead(deviceId: string, dir: string): ChronicleSnapshot | undefined {
  assertDeviceId(deviceId);
  return readChain(deviceId, dir).snapshots.at(-1);
}

/** The device's full chain, oldest first (empty when unknown). */
export function listSnapshots(deviceId: string, dir: string): ChronicleSnapshot[] {
  assertDeviceId(deviceId);
  return readChain(deviceId, dir).snapshots;
}

function requireSnapshot(chain: ChronicleChain, hash: string): ChronicleSnapshot {
  const found = chain.snapshots.find((s) => s.hash === hash);
  if (!found) throw new Error(`Unknown snapshot hash ${hash} for device ${chain.deviceId}`);
  return found;
}

/**
 * Diff between two points of a device's chain.
 * - no options / `toHash` only → the stored write-time diff of that node
 * - `fromHash` given → a recomputed diff across the span (cumulative change)
 */
export function getDiff(
  deviceId: string,
  dir: string,
  options: { fromHash?: string; toHash?: string } = {},
): SemanticChange[] {
  assertDeviceId(deviceId);
  const chain = readChain(deviceId, dir);
  const to = options.toHash ? requireSnapshot(chain, options.toHash) : chain.snapshots.at(-1);
  if (!to) return [];
  if (options.fromHash === undefined) return to.diff;
  const from = requireSnapshot(chain, options.fromHash);
  return semanticDiff(parseCanonical(from.canonical), parseCanonical(to.canonical));
}
