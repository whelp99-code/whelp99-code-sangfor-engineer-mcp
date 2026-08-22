import {
  existsSync,
  appendFileSync,
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

// ── HTTP exposure guard ─────────────────────────────────────────────────────
// The operator-console / http-bridge servers previously bound to 0.0.0.0 with no
// auth, exposing device-adjacent tooling to the LAN. These helpers make loopback
// the default, gate requests behind an optional shared secret, and fail closed
// when a non-loopback bind has no token.

export function resolveBindHost(): string {
  const raw = process.env.BIND_HOST?.trim();
  return raw ? raw : '127.0.0.1'; // empty/whitespace must not become an all-interfaces bind
}

export function isLoopback(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === 'localhost' || h === '::1') return true;
  // IPv4-mapped IPv6 loopback (e.g. ::ffff:127.0.0.1)
  const mapped = h.startsWith('::ffff:') ? h.slice(7) : h;
  if (isIP(mapped) === 4) {
    return mapped.split('.')[0] === '127'; // entire 127.0.0.0/8 range
  }
  return false;
}

/** Constant-time Bearer-token check. Open (ok) when no token is configured. */
export function checkAuth(authHeader: string | undefined, token: string | undefined): { ok: boolean; status?: number } {
  if (!token) return { ok: true };
  // Hash both sides to a fixed width first: constant-time regardless of input length
  // (no early length branch leaking the secret's size) and never throws.
  const h = (s: string) => createHash('sha256').update(s).digest();
  const ok = timingSafeEqual(h(authHeader ?? ''), h(`Bearer ${token}`));
  return ok ? { ok: true } : { ok: false, status: 401 };
}

/** Refuse to start a routable (non-loopback) server with no shared secret. */
export function assertBindSafety(bindHost: string, token: string | undefined): void {
  if (!isLoopback(bindHost) && !token) {
    throw new Error(
      `Refusing to bind ${bindHost} (non-loopback) without SANGFOR_API_TOKEN — set a token or bind to 127.0.0.1`,
    );
  }
}

/**
 * Walk up from this module to the workspace root (marked by pnpm-workspace.yaml),
 * so data roots resolve relative to the CODE, not the process cwd. Without this,
 * running the MCP/http-bridge/Docker from any other directory made every loader
 * silently return empty — indistinguishable from "nothing is misconfigured".
 */
function findRepoRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 16; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Resolve a repo data directory anchored to the package. An env override (if given)
 * always wins. Otherwise anchor to the workspace root + subdir.
 */
const unanchoredWarned = new Set<string>();
export function resolveRepoData(subdir: string, envVar?: string): string {
  const override = envVar ? process.env[envVar] : undefined;
  if (override) return override;
  const root = findRepoRoot();
  if (!root) {
    // Can't anchor (stripped/relocated deploy) and no env override → a cwd-relative
    // path here would silently return empty (the regression this helper exists to
    // kill). Emit a loud one-time diagnostic pointing at the fix.
    if (!unanchoredWarned.has(subdir)) {
      unanchoredWarned.add(subdir);
      process.stderr.write(`[data-root] could not anchor '${subdir}' (no pnpm-workspace.yaml found) — set ${envVar ?? 'SANGFOR_*_ROOT'} to avoid silent-empty data\n`);
    }
    return subdir;
  }
  return join(root, subdir);
}

// ── Atomic writes + directory locks ─────────────────────────────────────────
// Generalized from sangfor-learning-strategy's store.ts (the first place this
// repo got wx-temp + fsync + PID/UUID naming + parent-dir fsync right). New
// file-backed stores should use these instead of growing their own copy of the
// same pattern. learning-strategy/store.ts and sangfor-approval keep their
// existing inline implementations untouched — they already shipped and pass
// their own tests, so switching them over is a pure regression risk with no
// behavior upside.

function monotonicNowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function pauseSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function syncParentDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/**
 * Write `data` to `filePath` atomically: write to a PID+UUID temp file with
 * exclusive create ('wx' — never overwrites another writer's temp file),
 * fsync it, rename over the target (atomic on POSIX filesystems), then fsync
 * the parent directory so the rename survives a crash. A crash mid-write
 * leaves only the orphaned temp file behind; the target is never partially
 * written.
 */
export function writeFileAtomicSync(filePath: string, data: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(tempPath, 'wx', 0o600);
  try {
    const bytes = Buffer.from(data, 'utf8');
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset, null);
    fsyncSync(fd);
    chmodSync(tempPath, 0o600);
  } finally {
    closeSync(fd);
  }
  renameSync(tempPath, filePath);
  syncParentDirectory(dir);
}

export class DirLockTimeoutError extends Error {
  constructor(lockPath: string, waitMs: number) {
    super(`LOCK_TIMEOUT: could not acquire directory lock at ${lockPath} within ${waitMs}ms`);
    this.name = 'DirLockTimeoutError';
  }
}

/**
 * Run `fn` while holding an exclusive directory-based mutex at `lockPath`
 * (mkdirSync is atomic create-if-absent on every platform this repo targets).
 * Waits up to `waitMs` (default 2000), throwing DirLockTimeoutError if the
 * lock is still held at the deadline. The lock is always released in
 * `finally`, even when `fn` throws.
 *
 * If the lock directory's mtime is older than `staleLockMs` (default 30000),
 * it is treated as abandoned — left behind by a holder that crashed or was
 * killed before its own `finally` could run — and reclaimed immediately
 * (rmdirSync + a one-line stderr warning) instead of waiting out the full
 * budget. A race where another caller reaps it first (ENOENT on our rmdirSync)
 * is normal contention, not an error.
 *
 * Ownership token: on acquisition an `owner` file (`${pid}:${randomUUID()}`)
 * is written inside the lock directory. Release only rmdirs the lock if that
 * file still holds OUR token; a mismatch (or the file being gone) means
 * someone else reclaimed this lock as stale while we were still inside `fn`
 * — we back off with a warning instead of deleting the new holder's lock.
 * Trade-off (intentional, not fully closed): a holder whose critical section
 * legitimately runs longer than `staleLockMs` can still be wrongly reclaimed
 * by another caller — this only stops the reclaimed lock from then being
 * double-released. Callers with slow critical sections must pass a
 * `staleLockMs` comfortably above their worst-case duration.
 */
export function withDirLock<T>(
  lockPath: string,
  fn: () => T,
  opts: { waitMs?: number; staleLockMs?: number } = {},
): T {
  const waitMs = opts.waitMs ?? 2_000;
  const staleLockMs = opts.staleLockMs ?? 30_000;
  const ownerPath = join(lockPath, 'owner');
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = monotonicNowMs() + waitMs;
  let ownToken: string | undefined;
  for (;;) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      chmodSync(lockPath, 0o700);
      ownToken = `${process.pid}:${randomUUID()}`;
      writeFileSync(ownerPath, ownToken, { mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

      let ageMs = -1;
      try {
        ageMs = Date.now() - statSync(lockPath).mtimeMs;
      } catch {
        // Lock vanished between our failed mkdirSync and this stat — another
        // holder likely has it now; fall through to normal contention below.
      }
      if (ageMs >= 0 && ageMs > staleLockMs) {
        try {
          try { unlinkSync(ownerPath); } catch { /* owner file may already be gone; fine */ }
          rmdirSync(lockPath);
          process.stderr.write(`[shared] removing stale lock ${lockPath} (age ${Math.round(ageMs)}ms)\n`);
          continue; // reclaimed — retry mkdirSync immediately, no wait
        } catch (reapError) {
          if ((reapError as NodeJS.ErrnoException).code !== 'ENOENT') throw reapError;
          // Someone else already reaped/released it — normal contention.
        }
      }

      const remaining = deadline - monotonicNowMs();
      if (remaining <= 0) throw new DirLockTimeoutError(lockPath, waitMs);
      pauseSync(Math.min(25, remaining));
    }
  }
  try {
    return fn();
  } finally {
    try {
      let currentOwner: string | undefined;
      try { currentOwner = readFileSync(ownerPath, 'utf8'); } catch { /* missing → treated as taken-over below */ }
      if (currentOwner !== ownToken) {
        process.stderr.write(`[shared] lock ${lockPath} was taken over — skipping release\n`);
      } else {
        try { unlinkSync(ownerPath); } catch { /* best effort; rmdirSync below still fails loud if this leaves other entries */ }
        rmdirSync(lockPath);
      }
    } catch {
      /* leave a failed lock fail-closed */
    }
  }
}

// ── Engagement-scoped data (multi-customer deployment isolation) ───────────
// A single server process serving several customer engagements must not let
// their file-backed data bleed together. SANGFOR_ENGAGEMENT_ID, when set,
// isolates specific data roots (see resolveEngagementScopedData) under an
// extra path segment. Unset (the common case) is byte-identical to the
// unscoped resolveRepoData path — nothing changes for single-tenant use.
const ENGAGEMENT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/u;

/**
 * The active engagement id from SANGFOR_ENGAGEMENT_ID, or undefined when the
 * env var is unset/blank. Validates as a safe single path segment and fails
 * loud (throws) on anything else — a malformed id must never silently fall
 * through to the unscoped root or escape via '..'.
 */
export function activeEngagementId(): string | undefined {
  const raw = process.env.SANGFOR_ENGAGEMENT_ID?.trim();
  if (!raw) return undefined;
  // '.' would join() back to the unscoped base — an "enabled" scope with no
  // isolation at all — so it is rejected alongside traversal.
  if (raw === '.' || raw.includes('..') || !ENGAGEMENT_ID_RE.test(raw)) {
    throw new Error(
      `Invalid SANGFOR_ENGAGEMENT_ID "${raw}": must match ${ENGAGEMENT_ID_RE.source} and must not be '.' or contain '..'.`,
    );
  }
  return raw;
}

/**
 * Engagement-scoped variant of resolveRepoData: when an engagement is active,
 * data isolates under resolveRepoData(subdir, envVar)/<engagementId>;
 * otherwise this is identical to resolveRepoData(subdir, envVar).
 */
export function resolveEngagementScopedData(subdir: string, envVar?: string): string {
  const base = resolveRepoData(subdir, envVar);
  const engagementId = activeEngagementId();
  return engagementId ? join(base, engagementId) : base;
}

export type ProductCode =
  | 'HCI_SCP'
  | 'HCI'
  | 'NGFW'
  | 'SCC'
  | 'IAG'
  | 'ENDPOINT_SECURE'
  | 'NDR'
  | 'CYBER_COMMAND'
  | 'OTHER';

export const PRODUCT_PRIORITY: ProductCode[] = [
  'HCI_SCP',
  'IAG',
  'ENDPOINT_SECURE',
  'NDR',
  'HCI',
  'CYBER_COMMAND',
  'NGFW',
  'SCC',
  'OTHER'
];

export interface SangforProduct {
  code: ProductCode;
  name: string;
  priority: number;
  aliases: string[];
  mvpScope: string[];
}

export const PRODUCTS: SangforProduct[] = [
  {
    code: 'HCI_SCP',
    name: 'Sangfor HCI/SCP',
    priority: 1,
    aliases: ['HCI/SCP', 'SCP', 'Sangfor Cloud Platform', 'Sangfor SCP', 'aCloud', 'HCI SCP'],
    mvpScope: ['API-first config collection', 'resource pool and VM planning', 'HA/DRS planning', 'license and alert validation']
  },
  {
    code: 'HCI',
    name: 'Sangfor HCI',
    priority: 5,
    aliases: ['HCI', 'aSV', 'Sangfor HCI', 'Hyper-Converged Infrastructure'],
    mvpScope: ['cluster deployment', 'network precheck', 'storage precheck', 'VM migration planning', 'DR PoC planning']
  },
  {
    code: 'NGFW',
    name: 'Sangfor NGFW',
    priority: 7,
    aliases: ['NGFW', 'NGAF', 'Athena NGFW', 'Next-Generation Firewall'],
    mvpScope: ['firewall policy planning', 'bandwidth management', 'VPN planning', 'security validation']
  },
  {
    code: 'SCC',
    name: 'Sangfor Data Center Cloud',
    priority: 8,
    aliases: ['SCC', 'Sangfor Data Center Cloud', 'Data Center Cloud'],
    mvpScope: ['tenant operations', 'quota planning', 'cloud resource validation']
  },
  {
    code: 'IAG',
    name: 'Sangfor IAG',
    priority: 2,
    aliases: ['IAG', 'Internet Access Gateway', 'IAM', 'access gateway'],
    mvpScope: ['user/group policy planning', 'internet access control', 'authentication integration', 'audit log validation']
  },
  {
    code: 'ENDPOINT_SECURE',
    name: 'Sangfor Endpoint Secure',
    priority: 3,
    aliases: ['Endpoint Secure', 'Endpoint Security', 'EPP', 'EDR', 'aSEC'],
    mvpScope: ['agent deployment plan', 'EPP/EDR policy plan', 'exception policy', 'update and rollout validation']
  },
  {
    code: 'NDR',
    name: 'Sangfor NDR / Cyber Command',
    priority: 4,
    aliases: ['NDR', 'Athena NDR', 'Cyber Command', 'Sangfor Cyber Command', 'security operations', 'SOC'],
    mvpScope: ['event source onboarding', 'incident and alert validation', 'SOAR/playbook planning', 'third-party API integration readiness']
  },
  {
    code: 'CYBER_COMMAND',
    name: 'Sangfor Cyber Command',
    priority: 6,
    aliases: ['Cyber Command legacy', 'Sangfor Cyber Command legacy'],
    mvpScope: ['event collection planning', 'alert policy planning', 'dashboard/report validation', 'integration readiness']
  },
  {
    code: 'OTHER',
    name: 'Other Sangfor Product',
    priority: 99,
    aliases: ['OTHER'],
    mvpScope: ['source-preserving knowledge retrieval']
  }
];

export type ProjectType = 'deployment' | 'poc' | 'migration' | 'dr' | 'troubleshooting' | 'policy_design' | 'monitoring';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type ApprovalStatus = 'not_required' | 'pending' | 'approved' | 'rejected';

export interface ProjectInput {
  customerName: string;
  product?: string;
  version?: string;
  projectType?: ProjectType | string;
  environment?: Record<string, unknown>;
  requirements?: string[];
  constraints?: string[];
}

export interface ProjectAnalysis {
  customerName: string;
  detectedProduct: ProductCode;
  detectedVersion?: string;
  projectType: ProjectType;
  riskLevel: RiskLevel;
  missingInputs: string[];
  assumptions: string[];
  recommendedKnowledgeQueries: string[];
}

export interface KnowledgeChunk {
  id: string;
  sourceType: 'manual' | 'wiki' | 'lesson' | 'pattern';
  product: ProductCode;
  version?: string;
  title: string;
  section?: string;
  text: string;
  trustLevel: 'official' | 'internal' | 'draft' | 'needs_review' | 'customer';
}

export interface ConfigStep {
  id: string;
  title: string;
  description: string;
  product: ProductCode;
  phase: 'precheck' | 'configure' | 'validate' | 'rollback';
  approvalRequired: boolean;
  riskLevel: RiskLevel;
  references: string[];
}

export interface ConfigPlan {
  id: string;
  customerName: string;
  product: ProductCode;
  version?: string;
  planTitle: string;
  planSummary: string;
  riskLevel: RiskLevel;
  precheck: ConfigStep[];
  steps: ConfigStep[];
  approvalRequiredSteps: ConfigStep[];
  rollbackPlan: ConfigStep[];
  validationPlan: ConfigStep[];
  manualReferences: KnowledgeChunk[];
  wikiReferences: KnowledgeChunk[];
  lessonReferences: KnowledgeChunk[];
}

export interface ApprovalDecision {
  required: boolean;
  riskLevel: RiskLevel;
  reason: string;
}

export interface ConsoleAction {
  type: 'navigate' | 'click' | 'type' | 'select' | 'scroll' | 'screenshot' | 'wait';
  target?: string;
  value?: string;
  dryRun?: boolean;
}

export interface ConsoleActionResult {
  ok: boolean;
  dryRun: boolean;
  approvalRequired: boolean;
  message: string;
  beforeScreenshotPath?: string;
  afterScreenshotPath?: string;
}

export function normalizeProduct(input?: string): ProductCode {
  const raw = (input ?? '').trim();
  const value = raw.toLowerCase().replace(/[\s-]+/g, '_');
  const exact = PRODUCTS.find(p => p.code.toLowerCase() === value || p.code === raw);
  if (exact) return exact.code;
  for (const product of PRODUCTS) {
    if (product.aliases.some(alias => {
      const a = alias.toLowerCase();
      return value === a.replace(/[\s-]+/g, '_') || new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(raw);
    })) return product.code;
  }
  return 'HCI';
}

/**
 * Single source of truth for "this text touches a sensitive topic and must stay out
 * of fine-tuning". The collector uses it to drop paragraphs/documents on the way in,
 * and the fine-tune validator uses it as the fail-closed gate on the way out. Both
 * sides MUST share this matcher: when they drifted apart the producer let plurals
 * through ("passwords", "license keys") while the validator flagged innocent
 * substrings ("footprint" contains "otp"), which failed a completed corpus at the
 * last step. Word boundaries keep the substring accidents out; the plural forms are
 * spelled explicitly so morphology cannot slip past the producer.
 */
const SENSITIVE_LEARNING_TOPIC =
  /\b(?:passwords?|otps?|mfa|license keys?|secrets?|privacy polic(?:y|ies)|personal information)\b/i;

export function containsSensitiveLearningTopic(text: string): boolean {
  return SENSITIVE_LEARNING_TOPIC.test(text);
}

export function nowId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

export function appendJsonl<T extends { id: string }>(path: string, record: T): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`);
}

export function foldJsonlById<T extends { id: string }>(path: string): Map<string, T> {
  const byId = new Map<string, T>();
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return byId;
    throw error;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as T;
      byId.set(record.id, record);
    } catch {
      continue;
    }
  }
  return byId;
}

// ── Cursor pagination (generalized from sangfor-learning-strategy's service.ts
// list(), which pioneered the opaque base64url-cursor-over-a-stable-key pattern
// for this repo). New list-shaped tools should use this instead of growing their
// own copy; the learning-strategy service keeps its own inline implementation
// (untouched here) to avoid a regression risk on an already-shipped tool. ──────

const CURSOR_RE = /^[A-Za-z0-9_-]{1,512}$/u;

/** Encode an item's stable key as an opaque base64url page cursor. */
export function encodeCursor(key: string): string {
  return Buffer.from(key, 'utf8').toString('base64url');
}

/** Decode a page cursor back to the stable key it was minted from. `undefined` in → `undefined` out (first page). Throws on a malformed cursor. */
export function decodeCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;
  if (!CURSOR_RE.test(cursor)) throw new Error('INVALID_CURSOR: cursor is malformed.');
  return Buffer.from(cursor, 'base64url').toString('utf8');
}

export interface PaginateOptions<T> {
  cursor?: string;
  limit?: number;
  defaultLimit?: number;
  maxLimit?: number;
  /** Must return a value that is stable and unique across `items` (e.g. an id). */
  getKey: (item: T) => string;
}

export interface PaginateResult<T> {
  items: T[];
  nextCursor?: string;
}

/**
 * Cursor-paginate a pre-sorted array by a stable per-item key. `items` must
 * already be sorted the way callers should see it — this only windows it.
 */
export function paginate<T>(items: readonly T[], opts: PaginateOptions<T>): PaginateResult<T> {
  const limit = opts.limit ?? opts.defaultLimit ?? 50;
  const maxLimit = opts.maxLimit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxLimit) {
    throw new Error(`INVALID_INPUT: limit must be 1..${maxLimit}.`);
  }
  const after = decodeCursor(opts.cursor);
  const start = after === undefined ? 0 : items.findIndex((item) => opts.getKey(item) === after) + 1;
  if (after !== undefined && start === 0) throw new Error('INVALID_CURSOR: cursor does not identify the current result set.');
  const page = items.slice(start, start + limit);
  const last = page.at(-1);
  return start + page.length < items.length && last
    ? { items: page, nextCursor: encodeCursor(opts.getKey(last)) }
    : { items: page };
}
