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
