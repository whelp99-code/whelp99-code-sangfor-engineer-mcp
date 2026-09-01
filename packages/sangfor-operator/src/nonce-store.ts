import { dirname, join } from 'node:path';
import { FileSingleUseNonceStore, hasApprovalControlCharacters } from '@sangfor/approval';
import { PostgresSingleUseNonceStore } from '../../sangfor-approval/src/postgres-nonce-store.js';
import { resolveProjectId } from '@sangfor/identity';
import { resolveProductionLocalWriteAuthority, resolveRepoData } from '@sangfor/shared';

// Durable single-use store for live-execution approval nonces (closes redteam R1:
// replay of a verified (action, nonce, expiresAt) tuple within its expiry window).
// Fail-closed: any storage error refuses consumption, which refuses execution.
//
// This module is the ONE place the execution gate picks a store. All three call
// sites — the operator gate, the MCP server's HCI write gate, and the http-bridge
// tool guard — consume through here, so "single use" means single use across the
// whole process rather than once per call site. Selecting a store is explicit:
// nothing silently falls back to the file store, because a deployment that
// believed it had a replica-safe control while actually holding a per-process one
// is precisely the failure this store exists to prevent.

export interface NonceConsumeResult {
  ok: boolean;
  reason?: string;
  code?: 'ALREADY_USED' | 'STORE_UNAVAILABLE' | 'STALE_EPOCH';
}

type Env = Readonly<Record<string, string | undefined>>;

const FAIL_CLOSED = 'nonce store misconfigured (fail-closed)';

export function defaultNonceStorePath(env: Env = process.env): string {
  return env.SANGFOR_NONCE_STORE_PATH ?? join(resolveRepoData('data/runtime'), 'approval-nonces.json');
}

export type NonceStoreSelection =
  | { readonly ok: true; readonly kind: 'file'; readonly path: string }
  | { readonly ok: true; readonly kind: 'postgres'; readonly connectionString: string; readonly projectId: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Decide which store backs the gate. `SANGFOR_NONCE_STORE` is `file` (default,
 * single-process safe) or `postgres` (replica safe). The postgres selection
 * needs a connection string AND a project scope, because the nonce row is
 * scoped by `project_id` under row-level security — an unscoped write is
 * refused by the database itself, so resolving the scope up front turns a
 * confusing runtime 42501 into a clear configuration refusal.
 */
export function resolveNonceStoreSelection(env: Env = process.env): NonceStoreSelection {
  const raw = env.SANGFOR_NONCE_STORE?.trim();
  const blroPostgres = env.SANGFOR_BLRO_AUTHORITY_STORE === 'postgres';
  const kind = raw === undefined || raw === '' ? (blroPostgres ? 'postgres' : 'file') : raw;

  if (kind === 'file') {
    if (blroPostgres) return { ok: false, reason: `${FAIL_CLOSED}: JM-local nonce store is superseded in BLRO postgres mode` };
    return { ok: true, kind: 'file', path: defaultNonceStorePath(env) };
  }
  if (kind !== 'postgres') {
    return {
      ok: false,
      reason: `${FAIL_CLOSED}: unknown SANGFOR_NONCE_STORE ${JSON.stringify(raw)} (expected 'file' or 'postgres')`,
    };
  }

  const connectionString = env.SANGFOR_BLRO_DATABASE_URL?.trim() || env.DATABASE_URL?.trim();
  if (!connectionString) {
    return {
      ok: false,
      reason: `${FAIL_CLOSED}: the postgres nonce store needs a connection string — set DATABASE_URL (or SANGFOR_BLRO_DATABASE_URL)`,
    };
  }

  const project = resolveProjectId(env);
  if (!project.ok) {
    return {
      ok: false,
      reason: `${FAIL_CLOSED}: the postgres nonce store needs a project scope — ${project.reason} (set SANGFOR_PROJECT_ID)`,
    };
  }

  return { ok: true, kind: 'postgres', connectionString, projectId: project.projectId };
}

export class FileNonceStore {
  private readonly sharedStore: FileSingleUseNonceStore;

  constructor(filePath: string = defaultNonceStorePath()) {
    this.sharedStore = new FileSingleUseNonceStore(filePath, resolveProductionLocalWriteAuthority({
      tenantId: 'local-primary', projectId: process.env.SANGFOR_ENGAGEMENT_ID ?? 'local-primary', actorId: 'local-primary',
      aggregate: 'approvals_nonces', sourceRoot: dirname(filePath),
    }));
  }

  async consume(nonce: string, expiresAt: string, now: Date = new Date()): Promise<NonceConsumeResult> {
    const result = await this.sharedStore.consume(nonce, expiresAt, now);
    if (result.ok || result.reason?.startsWith('approval nonce already used:')) return result;
    return { ok: false, reason: `nonce store unavailable (fail-closed): ${result.reason ?? 'unknown store error'}` };
  }
}

let fileStore: FileNonceStore | null = null;
let fileStorePath: string | null = null;

function fileStoreFor(path: string): FileNonceStore {
  if (!fileStore || fileStorePath !== path) {
    fileStore = new FileNonceStore(path);
    fileStorePath = path;
  }
  return fileStore;
}

let postgresStore: PostgresSingleUseNonceStore | null = null;
let postgresStoreKey: string | null = null;

function postgresStoreFor(connectionString: string, projectId: string): PostgresSingleUseNonceStore {
  const key = `${connectionString}\n${projectId}`;
  if (!postgresStore || postgresStoreKey !== key) {
    postgresStore = new PostgresSingleUseNonceStore({ connectionString });
    postgresStoreKey = key;
  }
  return postgresStore;
}

/**
 * Consume the approval's nonce through the selected store. This is the entry
 * point every execution gate uses; it is asynchronous because the durable store
 * is a database.
 */
export async function consumeApprovalNonceAsync(
  approval: { nonce: string; expiresAt: string; authorityEpoch: number },
  now?: Date,
  environment: Env = process.env,
): Promise<NonceConsumeResult> {
  if (hasApprovalControlCharacters(approval.nonce)) return { ok: false, reason: 'invalid nonce input' };
  const selection = resolveNonceStoreSelection(environment);
  if (!selection.ok) return { ok: false, reason: selection.reason };
  if (selection.kind === 'file') {
    return fileStoreFor(selection.path).consume(approval.nonce, approval.expiresAt, now);
  }
  return postgresStoreFor(selection.connectionString, selection.projectId)
    .consume(selection.projectId, approval.nonce, approval.expiresAt, approval.authorityEpoch, now ?? new Date());
}

/**
 * Synchronous consumption, kept for the file store only.
 *
 * When a non-file store is selected this REFUSES instead of quietly using the
 * file store: consuming the same nonce from two different stores would make the
 * single-use control mean "once per store", which is worse than not having the
 * database at all.
 */
export async function consumeApprovalNonce(
  approval: { nonce: string; expiresAt: string; authorityEpoch: number },
  now?: Date,
): Promise<NonceConsumeResult> {
  if (hasApprovalControlCharacters(approval.nonce)) return { ok: false, reason: 'invalid nonce input' };
  const selection = resolveNonceStoreSelection();
  if (!selection.ok) return { ok: false, reason: selection.reason };
  if (selection.kind !== 'file') {
    return {
      ok: false,
      reason: `${FAIL_CLOSED}: the ${selection.kind} nonce store is asynchronous — this synchronous path must not fall back to the file store`,
    };
  }
  return fileStoreFor(selection.path).consume(approval.nonce, approval.expiresAt, now);
}

/** Release the database connection held by a selected postgres store. */
export async function closeNonceStores(): Promise<void> {
  if (postgresStore) {
    await postgresStore.close();
    postgresStore = null;
    postgresStoreKey = null;
  }
}
