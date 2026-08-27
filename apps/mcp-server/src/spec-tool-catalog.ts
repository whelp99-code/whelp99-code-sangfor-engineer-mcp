import { loadSpec, listSpecCoverage, evaluateSpec, renderAdvisoryReport, renderAdvisoryReportDocx } from '../../../packages/sangfor-spec/src/index.js';
import type { IntendedSpec } from '../../../packages/sangfor-spec/src/index.js';
import { paginateOptionalField } from './catalog-query-support.js';
import type { ToolCatalogEntry } from './mcp-contracts.js';

export const specToolCatalog: readonly ToolCatalogEntry[] = [
  ["sangfor_evaluate_config", {
    description: 'Advisory (read-only) config check: compare an observed product config against an IntendedSpec (from manuals) and split findings into misconfiguration / missing / indeterminate / ok. Never mutates a device. INDETERMINATE never counts as pass; MUST items without a source citation stay indeterminate. Returns the evaluation and a Korean advisory report; pass docxPath to also write a .docx.',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, version: { type: 'string' }, observed: { type: 'object', description: 'observed config key→value map (from screenshot/backup/human)' }, spec: { type: 'object', description: 'optional inline IntendedSpec; if omitted, loaded by product+version' }, docxPath: { type: 'string', description: 'optional path to also write the report as a .docx' } }, required: ['observed'] },
    handler: (args: { product?: string; version?: string; observed: Record<string, unknown>; spec?: IntendedSpec; docxPath?: string }) => {
      const spec = args.spec ?? (args.product && args.version ? loadSpec(args.product, args.version) : null);
      if (!spec) return { error: `No IntendedSpec found for ${args.product ?? '?'} ${args.version ?? '?'}. Provide an inline spec or seed data/specs/. Coverage: ${JSON.stringify(listSpecCoverage())}` };
      const result = evaluateSpec(spec, args.observed ?? {});
      const report = renderAdvisoryReport(spec, result);
      const docx = args.docxPath ? renderAdvisoryReportDocx(spec, result, args.docxPath) : undefined;
      return { result, report, ...(docx ? { docx } : {}) };
    }
  }],
  ["sangfor_list_spec_coverage", {
    description: 'List which product/version IntendedSpecs exist (advisory coverage) so callers know what config checks are available. Optional cursor/limit page the list; omit both for the full list (default, backward-compatible).',
    inputSchema: { type: 'object', properties: { cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } } },
    handler: (args: { cursor?: string; limit?: number }) => {
      // listSpecCoverage() has no inherent order (directory listing) — sort by
      // product+version first so the same cursor always resumes at the same row.
      const sorted = [...listSpecCoverage()].sort((a, b) =>
        a.product === b.product ? a.version.localeCompare(b.version) : a.product.localeCompare(b.product));
      return paginateOptionalField(sorted, args, (c) => `${c.product}::${c.version}`, 'coverage');
    }
  }],
];
