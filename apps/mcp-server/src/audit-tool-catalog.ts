import { listAuditFrameworkSummaries, getAuditFramework, filterChecklistItems, computeGapReport } from '../../../packages/sangfor-audit/src/index.js';
import type { AuditGroup, AuditPriority, AuditOwner, AuditObservation } from '../../../packages/sangfor-audit/src/index.js';
import type { ProductCode } from '../../../packages/shared/src/index.js';
import { paginateOptionalField } from './catalog-query-support.js';
import { buildEvidencePackage } from '../../../packages/sangfor-evidence/src/evidence-package.js';
import type { EvidencePackageItem } from '../../../packages/sangfor-evidence/src/evidence-package.js';
import type { ToolCatalogEntry } from './mcp-contracts.js';

export const auditToolCatalog: readonly ToolCatalogEntry[] = [
  ["sangfor_audit_frameworks", {
    description: 'Read-only: list registered customer audit-checklist frameworks (e.g. a customer\'s security-audit master table promoted to data) — frameworkId, title, version, and item count. Use with sangfor_audit_checklist / sangfor_audit_gap_report.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => listAuditFrameworkSummaries(),
  }],
  ["sangfor_audit_checklist", {
    description: 'Read-only: list checklist items for one audit framework, optionally filtered by group/product/priority/owner. Sorted by itemId. Optional cursor/limit page the result; omit both for the full filtered list (default, backward-compatible).',
    inputSchema: {
      type: 'object',
      properties: {
        frameworkId: { type: 'string', description: 'Framework id from sangfor_audit_frameworks, e.g. "hyundai-supplier-2026".' },
        group: { type: 'string', enum: ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7'], description: 'Filter to one audit group.' },
        product: { type: 'string', description: 'Filter to items whose products include this @sangfor/shared ProductCode.' },
        priority: { type: 'string', enum: ['P1', 'P2', 'P3'], description: 'Filter to one priority.' },
        owner: { type: 'string', enum: ['customer', 'engineer', 'vendor'], description: 'Filter to one owning role.' },
        cursor: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['frameworkId'],
    },
    handler: (args: { frameworkId: string; group?: AuditGroup; product?: ProductCode; priority?: AuditPriority; owner?: AuditOwner; cursor?: string; limit?: number }) => {
      const framework = getAuditFramework(args.frameworkId);
      if (!framework) return { error: `UNKNOWN_FRAMEWORK: "${args.frameworkId}" is not registered. Call sangfor_audit_frameworks to see available ids.` };
      const filtered = filterChecklistItems(framework.items, {
        group: args.group,
        product: args.product,
        priority: args.priority,
        owner: args.owner,
      });
      return paginateOptionalField(filtered, args, (i) => i.itemId, 'items');
    },
  }],
  ["sangfor_audit_gap_report", {
    description: 'Read-only: build a gap report for an audit framework from observations you supply — {itemId, status: met|partial|gap|unknown, observed?, evidenceRefs?}. Every item in the framework is included even with no matching observation (reported as status "unknown" / verdict "미확인" — missing coverage is never hidden). missingEvidence is requiredEvidence in full when evidenceRefs is empty/omitted, and empty when any evidenceRefs are supplied (not a substring match). Returns per-item verdict (O/△/X/미확인) plus a summary {total, met, partial, gap, unknown, observedRatio (how much of the framework has been inspected), metRatio (how much of it passes)}.',
    inputSchema: {
      type: 'object',
      properties: {
        frameworkId: { type: 'string', description: 'Framework id from sangfor_audit_frameworks.' },
        observations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              itemId: { type: 'string' },
              status: { type: 'string', enum: ['met', 'partial', 'gap', 'unknown'] },
              observed: { type: 'string' },
              evidenceRefs: { type: 'array', items: { type: 'string' } },
            },
            required: ['itemId', 'status'],
          },
        },
      },
      required: ['frameworkId', 'observations'],
    },
    handler: (args: { frameworkId: string; observations: AuditObservation[] }) => {
      const framework = getAuditFramework(args.frameworkId);
      if (!framework) return { error: `UNKNOWN_FRAMEWORK: "${args.frameworkId}" is not registered. Call sangfor_audit_frameworks to see available ids.` };
      return computeGapReport(framework, args.observations ?? []);
    },
  }],
  ["sangfor_build_evidence_package", {
    description: 'Writes a local file (not a device change): assembles a customer-submission .docx evidence package via officecli (cover page, a summary table with per-verdict counts, one section per checklist item with its evidence images embedded, and — when captureRunId is given — a "증적 무결성" section reporting AuditLedger chain + per-file hash verification). observed/verdict text is used exactly as supplied, never summarized or inferred; items with no evidence file are marked "(증적 파일 없음)" (naming the expected files when any were claimed but none found) rather than silently skipped. items is shaped to accept sangfor_audit_gap_report output nearly as-is — see @sangfor/evidence gapReportItemsToEvidenceItems for the field mapping (evidenceRefs -> evidenceFiles). Auto-validates the result via officecli and returns it under validation. Defaults outputPath to the engagement-scoped evidence root under packages/<dateStamp>/. Refuses to overwrite an existing file at outputPath (OFFICE_FILE_EXISTS) unless overwrite:true is passed — a customer submission is never silently replaced.',
    inputSchema: {
      type: 'object',
      properties: {
        frameworkId: { type: 'string', description: 'Optional audit framework id, shown on the cover page.' },
        title: { type: 'string', description: 'Document title, e.g. "ITAC 보안 필수사항 점검 증적 패키지".' },
        customer: { type: 'string', description: 'Customer name, shown on the cover page.' },
        dateStamp: { type: 'string', description: 'Collection/authoring date, e.g. "20260806". Also used in the default outputPath.' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              itemId: { type: 'string' },
              topic: { type: 'string' },
              reqIds: { type: 'array', items: { type: 'string' } },
              status: { type: 'string', description: 'Observation status, e.g. met/partial/gap/unknown — used exactly as supplied.' },
              verdict: { type: 'string', description: 'Verdict text, e.g. O/△/X/미확인 — used exactly as supplied, not reinterpreted.' },
              observed: { type: 'string', description: 'Measured/observed text. Omit or pass "미확인" when not confirmed — never inferred.' },
              evidenceFiles: { type: 'array', items: { type: 'string' }, description: 'Local file paths of evidence images for this item. Missing/nonexistent files are reported honestly rather than embedded.' },
            },
            required: ['itemId', 'topic', 'reqIds', 'status', 'verdict'],
          },
        },
        captureRunId: { type: 'string', description: 'Optional sangfor_console_capture_evidence runId — adds a "증적 무결성" section verifying the AuditLedger chain and per-file hashes for that run.' },
        outputPath: { type: 'string', description: 'Optional output path. Defaults under the engagement-scoped evidence root at packages/<dateStamp>/.' },
        overwrite: { type: 'boolean', description: 'Default false. When outputPath already exists, the call is refused with OFFICE_FILE_EXISTS unless this is true — protects a customer submission from being silently replaced.' },
      },
      required: ['title', 'customer', 'dateStamp', 'items'],
    },
    handler: (args: { frameworkId?: string; title: string; customer: string; dateStamp: string; items: EvidencePackageItem[]; captureRunId?: string; outputPath?: string; overwrite?: boolean }) =>
      buildEvidencePackage(args),
  }],
];
