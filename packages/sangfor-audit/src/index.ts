/**
 * @sangfor/audit — Customer audit checklist frameworks as first-class data.
 *
 * A framework (e.g. "hyundai-supplier-2026") is one customer-audit master
 * table: a list of checklist items, each mapped to REQ numbers, a Sangfor
 * product/tool grouping, an inspection method, required evidence, an owning
 * role, and a priority. This is the reusable shape behind what used to be a
 * one-off hand-written Markdown master table per engagement.
 *
 * Loader follows the same fail-safe convention as packages/sangfor-safety and
 * packages/sangfor-competency: one corrupt or schema-invalid framework file
 * must never take down the others, and never crashes the caller. Validation
 * is hand-rolled (no zod), matching this repo's existing loaders.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRepoData, PRODUCTS, type ProductCode } from '../../shared/src/index.js';

export type AuditGroup = 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6' | 'G7';
export type AuditMethod = 'console_dryrun' | 'external_evidence' | 'change_required' | 'procedure';
export type AuditOwner = 'customer' | 'engineer' | 'vendor';
export type AuditPriority = 'P1' | 'P2' | 'P3';

export interface AuditChecklistItem {
  itemId: string;
  topic: string;
  reqIds: string[];
  group: AuditGroup;
  groupLabel: string;
  products: ProductCode[];
  externalTools?: string[];
  method: AuditMethod;
  requiredEvidence: string[];
  owner: AuditOwner;
  priority: AuditPriority;
}

export interface AuditFramework {
  frameworkId: string;
  title: string;
  version: string;
  sourceNote: string;
  items: AuditChecklistItem[];
}

export interface AuditFrameworkSummary {
  frameworkId: string;
  title: string;
  version: string;
  itemCount: number;
}

const GROUPS: readonly AuditGroup[] = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7'];
const METHODS: readonly AuditMethod[] = ['console_dryrun', 'external_evidence', 'change_required', 'procedure'];
const OWNERS: readonly AuditOwner[] = ['customer', 'engineer', 'vendor'];
const PRIORITIES: readonly AuditPriority[] = ['P1', 'P2', 'P3'];
const PRODUCT_CODES = new Set<string>(PRODUCTS.map((p) => p.code));

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Every element must be a string AND non-blank after trim — `[""]` / `["   "]` are rejected, not silently accepted. */
function isNonBlankStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim().length > 0);
}

type ValidationResult<T> = { ok: true; value: T } | { ok: false; reason: string };

function validateItem(raw: unknown, index: number): ValidationResult<AuditChecklistItem> {
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: `items[${index}] is not an object` };
  const item = raw as Record<string, unknown>;
  if (!isNonEmptyString(item.itemId)) return { ok: false, reason: `items[${index}].itemId missing/invalid` };
  if (!isNonEmptyString(item.topic)) return { ok: false, reason: `items[${index}].topic missing/invalid` };
  if (!isNonBlankStringArray(item.reqIds) || item.reqIds.length === 0) {
    return { ok: false, reason: `items[${index}].reqIds must be a non-empty array of non-blank strings` };
  }
  if (!GROUPS.includes(item.group as AuditGroup)) return { ok: false, reason: `items[${index}].group invalid` };
  if (!isNonEmptyString(item.groupLabel)) return { ok: false, reason: `items[${index}].groupLabel missing/invalid` };
  if (!Array.isArray(item.products) || !(item.products as unknown[]).every((p) => typeof p === 'string' && PRODUCT_CODES.has(p))) {
    return { ok: false, reason: `items[${index}].products must be an array of known @sangfor/shared ProductCode values` };
  }
  if (item.externalTools !== undefined && !isNonBlankStringArray(item.externalTools)) {
    return { ok: false, reason: `items[${index}].externalTools must be an array of non-blank strings when present` };
  }
  if (!METHODS.includes(item.method as AuditMethod)) return { ok: false, reason: `items[${index}].method invalid` };
  if (!isNonBlankStringArray(item.requiredEvidence) || item.requiredEvidence.length === 0) {
    return { ok: false, reason: `items[${index}].requiredEvidence must be a non-empty array of non-blank strings` };
  }
  if (!OWNERS.includes(item.owner as AuditOwner)) return { ok: false, reason: `items[${index}].owner invalid` };
  if (!PRIORITIES.includes(item.priority as AuditPriority)) return { ok: false, reason: `items[${index}].priority invalid` };

  const value: AuditChecklistItem = {
    itemId: item.itemId as string,
    topic: item.topic as string,
    reqIds: item.reqIds as string[],
    group: item.group as AuditGroup,
    groupLabel: item.groupLabel as string,
    products: item.products as ProductCode[],
    method: item.method as AuditMethod,
    requiredEvidence: item.requiredEvidence as string[],
    owner: item.owner as AuditOwner,
    priority: item.priority as AuditPriority,
  };
  if (item.externalTools !== undefined) value.externalTools = item.externalTools as string[];
  return { ok: true, value };
}

/** Hand-rolled schema check (no zod, matching this repo's other loaders). Never throws. */
export function validateAuditFramework(raw: unknown): ValidationResult<AuditFramework> {
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'framework is not an object' };
  const fw = raw as Record<string, unknown>;
  if (!isNonEmptyString(fw.frameworkId)) return { ok: false, reason: 'frameworkId missing/invalid' };
  if (!isNonEmptyString(fw.title)) return { ok: false, reason: 'title missing/invalid' };
  if (!isNonEmptyString(fw.version)) return { ok: false, reason: 'version missing/invalid' };
  if (!isNonEmptyString(fw.sourceNote)) return { ok: false, reason: 'sourceNote missing/invalid' };
  if (!Array.isArray(fw.items) || fw.items.length === 0) return { ok: false, reason: 'items missing/empty' };

  const items: AuditChecklistItem[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < fw.items.length; i++) {
    const result = validateItem(fw.items[i], i);
    if (!result.ok) return result;
    if (seenIds.has(result.value.itemId)) return { ok: false, reason: `duplicate itemId ${result.value.itemId}` };
    seenIds.add(result.value.itemId);
    items.push(result.value);
  }

  return {
    ok: true,
    value: {
      frameworkId: fw.frameworkId as string,
      title: fw.title as string,
      version: fw.version as string,
      sourceNote: fw.sourceNote as string,
      items,
    },
  };
}

const dataRoot = () => resolveRepoData('data/audit', 'SANGFOR_AUDIT_ROOT');

/**
 * Load every framework file under the audit data root. A single corrupt
 * (unparseable JSON) or schema-invalid file is skipped with a stderr warning
 * — it never takes down the other frameworks and never throws.
 */
export function loadAuditFrameworks(root: string = dataRoot()): AuditFramework[] {
  if (!existsSync(root)) return [];
  const out: AuditFramework[] = [];
  for (const f of readdirSync(root).filter((x) => x.endsWith('.json') && !x.startsWith('.'))) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(root, f), 'utf8'));
    } catch {
      process.stderr.write(`[audit] skipping unparseable framework file: ${f}\n`);
      continue;
    }
    const result = validateAuditFramework(parsed);
    if (!result.ok) {
      process.stderr.write(`[audit] skipping invalid framework file ${f}: ${result.reason}\n`);
      continue;
    }
    out.push(result.value);
  }
  return out.sort((a, b) => a.frameworkId.localeCompare(b.frameworkId));
}

export function getAuditFramework(frameworkId: string, root: string = dataRoot()): AuditFramework | undefined {
  return loadAuditFrameworks(root).find((f) => f.frameworkId === frameworkId);
}

export function listAuditFrameworkSummaries(root: string = dataRoot()): AuditFrameworkSummary[] {
  return loadAuditFrameworks(root).map((f) => ({
    frameworkId: f.frameworkId,
    title: f.title,
    version: f.version,
    itemCount: f.items.length,
  }));
}

export interface ChecklistFilter {
  group?: AuditGroup;
  product?: ProductCode;
  priority?: AuditPriority;
  owner?: AuditOwner;
}

/** Filter + sort by itemId. Pagination (cursor/limit) is layered on top by the MCP tool, not here. */
export function filterChecklistItems(items: readonly AuditChecklistItem[], filter: ChecklistFilter = {}): AuditChecklistItem[] {
  return items
    .filter((i) => (filter.group ? i.group === filter.group : true))
    .filter((i) => (filter.product ? i.products.includes(filter.product) : true))
    .filter((i) => (filter.priority ? i.priority === filter.priority : true))
    .filter((i) => (filter.owner ? i.owner === filter.owner : true))
    .slice()
    .sort((a, b) => a.itemId.localeCompare(b.itemId));
}

export type ObservationStatus = 'met' | 'partial' | 'gap' | 'unknown';
export type GapVerdict = 'O' | '△' | 'X' | '미확인';

export interface AuditObservation {
  itemId: string;
  status: ObservationStatus;
  observed?: string;
  evidenceRefs?: string[];
}

export interface GapReportItem {
  itemId: string;
  topic: string;
  reqIds: string[];
  requiredEvidence: string[];
  status: ObservationStatus;
  observed?: string;
  evidenceRefs?: string[];
  missingEvidence: string[];
  verdict: GapVerdict;
}

export interface GapReportSummary {
  total: number;
  met: number;
  partial: number;
  gap: number;
  unknown: number;
  /** Inspection progress: (total - unknown) / total. How much of the checklist has an observation at all, regardless of verdict. */
  observedRatio: number;
  /** Pass rate: met / total. How much of the checklist is fully satisfied. Distinct from observedRatio — a fully-inspected checklist full of gaps has observedRatio 1 but metRatio 0. */
  metRatio: number;
}

export interface GapReport {
  frameworkId: string;
  items: GapReportItem[];
  summary: GapReportSummary;
}

const VERDICT_BY_STATUS: Record<ObservationStatus, GapVerdict> = {
  met: 'O',
  partial: '△',
  gap: 'X',
  unknown: '미확인',
};

/**
 * Build a gap report for every item in `framework`, keyed against observations
 * by itemId. An item with no matching observation is never dropped — it is
 * reported as status 'unknown' / verdict '미확인' so missing coverage is
 * never silently hidden.
 *
 * missingEvidence is intentionally NOT a substring/contains match between
 * requiredEvidence and evidenceRefs (that would be an arbitrary and unstable
 * heuristic) — it is the plain binary rule: no evidenceRefs supplied at all
 * means every requiredEvidence entry for that item is missing; any
 * evidenceRefs supplied means the caller is vouching evidence was checked,
 * so nothing is reported missing.
 */
export function computeGapReport(framework: AuditFramework, observations: readonly AuditObservation[]): GapReport {
  const byItemId = new Map(observations.map((o) => [o.itemId, o]));
  const items: GapReportItem[] = framework.items
    .slice()
    .sort((a, b) => a.itemId.localeCompare(b.itemId))
    .map((item) => {
      const obs = byItemId.get(item.itemId);
      const status: ObservationStatus = obs?.status ?? 'unknown';
      const evidenceRefs = obs?.evidenceRefs;
      const missingEvidence = evidenceRefs === undefined || evidenceRefs.length === 0
        ? [...item.requiredEvidence]
        : [];
      const out: GapReportItem = {
        itemId: item.itemId,
        topic: item.topic,
        reqIds: item.reqIds,
        requiredEvidence: item.requiredEvidence,
        status,
        missingEvidence,
        verdict: VERDICT_BY_STATUS[status],
      };
      if (obs?.observed !== undefined) out.observed = obs.observed;
      if (obs?.evidenceRefs !== undefined) out.evidenceRefs = obs.evidenceRefs;
      return out;
    });

  const summary: GapReportSummary = { total: 0, met: 0, partial: 0, gap: 0, unknown: 0, observedRatio: 0, metRatio: 0 };
  for (const i of items) {
    summary.total++;
    summary[i.status]++;
  }
  summary.observedRatio = summary.total > 0 ? (summary.total - summary.unknown) / summary.total : 0;
  summary.metRatio = summary.total > 0 ? summary.met / summary.total : 0;

  return { frameworkId: framework.frameworkId, items, summary };
}
