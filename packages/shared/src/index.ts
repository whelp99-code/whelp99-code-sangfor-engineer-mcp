import { existsSync, appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, timingSafeEqual } from 'node:crypto';
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

export type ProductCode = 'HCI_SCP' | 'HCI' | 'IAG' | 'ENDPOINT_SECURE' | 'NDR' | 'CYBER_COMMAND';

export const PRODUCT_PRIORITY: ProductCode[] = [
  'HCI_SCP',
  'IAG',
  'ENDPOINT_SECURE',
  'NDR',
  'HCI',
  'CYBER_COMMAND'
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
