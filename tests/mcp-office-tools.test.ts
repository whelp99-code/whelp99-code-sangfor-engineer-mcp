import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MCP_NO_SERVE = '1';

let listTools: () => Array<{ name: string; description: string; inputSchema: unknown; annotations: { readOnlyHint: boolean; destructiveHint: boolean } }>;
let getToolHandler: (name: string) => ((args: unknown) => unknown) | undefined;

beforeAll(async () => {
  const mod = await import('../apps/mcp-server/src/index.js');
  listTools = mod.listTools as typeof listTools;
  getToolHandler = mod.getToolHandler as typeof getToolHandler;
});

const { isOfficeCliAvailable } = await import('../packages/sangfor-office/src/index.js');
const officeCliInstalled = isOfficeCliAvailable().available;

describe('sangfor_validate_office_document — MCP surface', () => {
  it('is registered, read-only, non-destructive', () => {
    const tool = listTools().find((t) => t.name === 'sangfor_validate_office_document');
    expect(tool).toBeTruthy();
    expect(tool!.annotations.readOnlyHint).toBe(true);
    expect(tool!.annotations.destructiveHint).toBe(false);
    expect((tool!.inputSchema as { required?: string[] }).required).toEqual(['filePath']);
  });

  it('never throws — degrades to valid:null with officeCli.available reported when officecli cannot validate a nonexistent path', async () => {
    const handler = getToolHandler('sangfor_validate_office_document')!;
    const result = (await handler({ filePath: '/tmp/sangfor-validate-tool-does-not-exist.docx' })) as {
      valid: boolean | null;
      errorCount: number;
      errors: string[];
      officeCli: { available: boolean };
    };
    expect(typeof result.officeCli.available).toBe('boolean');
    if (!officeCliInstalled) {
      expect(result.valid).toBeNull();
      expect(result.errors).toEqual([]);
    }
  });
});

describe('sangfor_build_evidence_package — MCP surface', () => {
  it('is registered, marked as a write tool (not destructive), and exposes overwrite:boolean', () => {
    const tool = listTools().find((t) => t.name === 'sangfor_build_evidence_package');
    expect(tool).toBeTruthy();
    expect(tool!.annotations.readOnlyHint).toBe(false);
    expect(tool!.annotations.destructiveHint).toBe(false);
    expect((tool!.inputSchema as { required?: string[] }).required).toEqual(['title', 'customer', 'dateStamp', 'items']);
    // P2 (cross-review fix): overwrite must be a caller-visible opt-in, not
    // an internal default, so a customer submission is never silently
    // replaced via this tool.
    const properties = (tool!.inputSchema as { properties?: Record<string, { type?: string }> }).properties;
    expect(properties?.overwrite?.type).toBe('boolean');
  });

  it.skipIf(!officeCliInstalled)('builds a real package end-to-end through the tool handler — skipped: officecli not installed on this host', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sangfor-evidence-mcp-tool-'));
    const savedRoot = process.env.SANGFOR_EVIDENCE_ROOT;
    process.env.SANGFOR_EVIDENCE_ROOT = root;
    try {
      const handler = getToolHandler('sangfor_build_evidence_package')!;
      const result = (await handler({
        title: 'MCP Tool Test Package',
        customer: 'ITAC',
        dateStamp: '20260806',
        items: [
          { itemId: '01', topic: '테스트 항목', reqIds: ['REQ01'], status: 'unknown', verdict: '미확인' },
        ],
      })) as { outputPath: string; validation: { valid: boolean | null } };
      expect(existsSync(result.outputPath)).toBe(true);
      expect(result.validation.valid).toBe(true);

      // P2: re-invoking the tool against the same outputPath must refuse,
      // and only succeed once overwrite:true is passed explicitly.
      await expect(handler({
        title: 'MCP Tool Test Package', customer: 'ITAC', dateStamp: '20260806',
        items: [{ itemId: '01', topic: '테스트 항목', reqIds: ['REQ01'], status: 'unknown', verdict: '미확인' }],
        outputPath: result.outputPath,
      })).rejects.toThrow(/OFFICE_FILE_EXISTS/);

      const overwritten = (await handler({
        title: 'MCP Tool Test Package', customer: 'ITAC', dateStamp: '20260806',
        items: [{ itemId: '01', topic: '테스트 항목', reqIds: ['REQ01'], status: 'unknown', verdict: '미확인' }],
        outputPath: result.outputPath, overwrite: true,
      })) as { validation: { valid: boolean | null } };
      expect(overwritten.validation.valid).toBe(true);
    } finally {
      if (savedRoot === undefined) delete process.env.SANGFOR_EVIDENCE_ROOT;
      else process.env.SANGFOR_EVIDENCE_ROOT = savedRoot;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
