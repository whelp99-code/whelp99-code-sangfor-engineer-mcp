import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const responseSchema = z.object({
  jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number(), z.null()]),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
}).strict().refine((row) => (row.result !== undefined) !== (row.error !== undefined));
const toolSchema = z.object({ isError: z.boolean(), structuredContent: z.unknown() });

// Synthetic checklist only. These bytes are not official captures or field evidence.
const step = (id: string, phase: string) => ({
  id, phase, product: 'HCI', title: 'Fixture checklist', description: 'Synthetic, no equipment access.',
  riskLevel: 'low', approvalRequired: false, references: ['fixture-reference'],
});
const plan = {
  id: 'stdio-fixture', product: 'HCI', customerName: 'fixture-lab',
  planTitle: 'Synthetic protocol fixture', planSummary: 'Not field evidence', riskLevel: 'low',
  steps: [step('configure', 'configure')], precheck: [step('precheck', 'precheck')],
  rollbackPlan: [step('rollback', 'rollback')], validationPlan: [step('validate', 'validate')],
  approvalRequiredSteps: [], wikiReferences: [], lessonReferences: [],
  manualReferences: [{ id: 'fixture-reference', product: 'HCI', title: 'Synthetic reference',
    text: 'Fixture-only manual shape; not captured documentation.', sourceType: 'manual', trustLevel: 'official' }],
};

describe('real stdio notification framing', () => {
  it('emits only correlated request frames, keeps malformed-input errors, and completes both static verifier calls', () => {
    const home = mkdtempSync(join(tmpdir(), 'mcp-notifications-'));
    const request = (id: string | number, method: string, params = {}) => ({ jsonrpc: '2.0', id, method, params });
    const messages = [
      request(0, 'initialize'),
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      request('catalog', 'tools/list'),
      { jsonrpc: '2.0', method: 'notifications/unknown' },
      { jsonrpc: '2.0', method: 'tools/call', params: { name: 'sangfor_products', arguments: {} } },
      request('valid', 'tools/call', { name: 'sangfor_verify_result', arguments: { plan } }),
      request('invalid', 'tools/call', { name: 'sangfor_verify_result', arguments: { plan: { ...plan, precheck: [] } } }),
      request('', 'unknown'),
      request('unknown-tool', 'tools/call', { name: 'absent', arguments: {} }),
    ].map((message) => JSON.stringify(message));
    messages.push('{', JSON.stringify({ jsonrpc: '2.0', id: 91, method: 'tools/list', params: [] }));
    try {
      // Deliberately do not inherit remote endpoints, credentials, live flags, VITEST or MCP_NO_SERVE.
      const child = spawnSync(process.execPath, ['--import', 'tsx', 'apps/mcp-server/src/index.ts'], {
        cwd: join(import.meta.dirname, '..'), encoding: 'utf8', timeout: 5_000,
        env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, NODE_ENV: 'test',
          SANGFOR_ALLOW_REAL_EXECUTION: 'false', SANGFOR_ALLOW_PRODUCTION_EXECUTION: 'false',
          SANGFOR_TOOL_PROFILE: 'full', SANGFOR_BLRO_AUTHORITY_STORE: 'local' },
        input: messages.join('\n') + '\n',
      });
      expect(child.error, child.stderr).toBeUndefined();
      expect(child.signal, child.stderr).toBeNull();
      expect(child.status, child.stderr).toBe(0);
      expect(child.stdout.endsWith('\n')).toBe(true);
      // Parse EVERY line through process close: no discarded non-JSON, unsolicited or duplicate frames.
      const rows = child.stdout.slice(0, -1).split('\n').map((line) => responseSchema.parse(JSON.parse(line)));
      expect(rows).toHaveLength(8);
      expect(rows.filter((row) => row.id !== null).map((row) => row.id).sort())
        .toEqual(['', 0, 'catalog', 'valid', 'invalid', 'unknown-tool'].sort());
      const result = (id: string | number) => {
        const row = rows.find((candidate) => candidate.id === id);
        expect(row).toBeDefined();
        return row?.result;
      };
      expect(result(0)).toMatchObject({ serverInfo: { name: 'sangfor-engineer-mcp' } });
      expect(z.object({ tools: z.array(z.object({ name: z.string() })) }).parse(result('catalog')).tools)
        .toContainEqual(expect.objectContaining({ name: 'sangfor_verify_result' }));
      const valid = toolSchema.parse(result('valid'));
      expect(valid.isError).toBe(false);
      expect(z.object({ ok: z.literal(true), mode: z.literal('dry'),
        checks: z.array(z.object({ status: z.literal('pending') })).nonempty(),
      }).safeParse(valid.structuredContent).success).toBe(true);
      const invalid = toolSchema.parse(result('invalid'));
      expect(invalid.isError).toBe(false);
      expect(z.object({ ok: z.literal(false), planErrors: z.array(z.string()).nonempty() })
        .safeParse(invalid.structuredContent).success).toBe(true);
      expect(rows.find((row) => row.id === '')?.error?.code).toBe(-32601);
      expect(toolSchema.parse(result('unknown-tool')).isError).toBe(true);
      const parseErrors = rows.filter((row) => row.id === null);
      expect(parseErrors).toHaveLength(2);
      expect(parseErrors.every((row) => row.error?.code === -32700)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
