import { testFileLocalWriteAuthority, testLocalWriteAuthority } from './helpers/local-write-authority.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import type { EvaluationResult } from '../packages/sangfor-spec/src/index.js';
import {
  appendEngineerReport,
  canonicalReportPreimage,
  listEngineerReports,
  validateEngineerReport,
  verifyReportChain,
  type EngineerReport,
  type EngineerReportInput,
} from '../packages/sangfor-engineer-report/src/index.js';

const engineResult: EvaluationResult = {
  specId: 'spec_fortios_8_0_0_policy',
  ok: false,
  items: [
    {
      id: 'ssl_inspection_enabled',
      label: 'SSL/TLS 검사 활성',
      verdict: 'FAIL',
      category: 'misconfiguration',
      observed: false,
      expected: true,
      reason: 'expected eq true, observed false',
    },
    {
      id: 'threat_logging_enabled',
      label: '위협 로깅 활성',
      verdict: 'PASS',
      category: 'ok',
      observed: true,
      expected: true,
      reason: 'matches expected',
    },
  ],
  summary: { pass: 1, fail: 1, indeterminate: 0, misconfiguration: 1, missing: 0, contextDependent: 0 },
  coverage: { specifiedTotal: 2, observedTotal: 2, unspecifiedKeys: [], unobservedItems: [] },
};

function input(overrides: Partial<EngineerReportInput> = {}): EngineerReportInput {
  return {
    reportId: 'rep_1',
    deviceId: 'fgt-01',
    snapshotHash: 'a'.repeat(64),
    engineResult,
    riskNote: 'SSL 검사 비활성 — 암호화 트래픽 위협 탐지 불가',
    recommendations: ['certificate-inspection 프로파일을 정책 1에 연결'],
    rollbackPlan: ['정책 1의 ssl-ssh-profile 을 이전 값(none)으로 복원'],
    ragCitations: [{ chunkId: 'chunk_ssl_1', filePath: 'data/kb/fortios/ssl-inspection.md' }],
    modelId: 'test-model-v1',
    promptHash: 'b'.repeat(64),
    createdAt: '2026-08-18T00:00:00.000Z',
    ...overrides,
  };
}

describe('@sangfor/engineer-report — F1 report contract', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'engineer-report-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('stamps schemaVersion 1 and carries the engine result verbatim', async () => {
    const { report } = await appendEngineerReport(dir, input(), testLocalWriteAuthority('evidence', dir));

    expect(report.schemaVersion).toBe(1);
    expect(report.reportId).toBe('rep_1');
    expect(report.deviceId).toBe('fgt-01');
    expect(report.engineResult).toEqual(engineResult);
    expect(report.recommendations).toEqual(['certificate-inspection 프로파일을 정책 1에 연결']);
    expect(report.rollbackPlan).toEqual(['정책 1의 ssl-ssh-profile 을 이전 값(none)으로 복원']);
    expect(report.ragCitations).toEqual([{ chunkId: 'chunk_ssl_1', filePath: 'data/kb/fortios/ssl-inspection.md' }]);
    expect(report.modelId).toBe('test-model-v1');
    expect(report.promptHash).toBe('b'.repeat(64));
    expect(report.createdAt).toBe('2026-08-18T00:00:00.000Z');
  });

  it('deep-copies the engine result so a later caller mutation cannot rewrite the ledger record', async () => {
    const mutable: EvaluationResult = JSON.parse(JSON.stringify(engineResult)) as EvaluationResult;
    const { report } = await appendEngineerReport(dir, input({ engineResult: mutable }), testLocalWriteAuthority('evidence', dir));

    (mutable.items[0] as { verdict: string }).verdict = 'PASS';

    expect(report.engineResult.items[0].verdict).toBe('FAIL');
    expect(listEngineerReports(dir)[0].engineResult.items[0].verdict).toBe('FAIL');
  });

  it('rejects a report whose id or device id is unusable as a ledger key', async () => {
    await expect(async () => await appendEngineerReport(dir, input({ reportId: '' }), testLocalWriteAuthority('evidence', dir))).rejects.toThrow(/reportId/i);
    await expect(async () => await appendEngineerReport(dir, input({ deviceId: '../escape' }), testLocalWriteAuthority('evidence', dir))).rejects.toThrow(/deviceId/i);
  });
});

describe('@sangfor/engineer-report — hash-chained ledger', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'engineer-report-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('chains records: first prevHash is GENESIS and each hash is sha256 of the canonical record', async () => {
    const first = await appendEngineerReport(dir, input(), testLocalWriteAuthority('evidence', dir));
    const second = await appendEngineerReport(dir, input({ reportId: 'rep_2', createdAt: '2026-08-18T00:01:00.000Z' }), testLocalWriteAuthority('evidence', dir));

    expect(first.record.prevHash).toBe('GENESIS');
    expect(first.record.hash).toBe(createHash('sha256').update(canonicalReportPreimage('GENESIS', first.report)).digest('hex'));
    expect(second.record.prevHash).toBe(first.record.hash);
    expect(second.record.hash).toBe(createHash('sha256').update(canonicalReportPreimage(first.record.hash, second.report)).digest('hex'));
    expect(second.record.seq).toBe(2);
  });

  it('persists one JSONL line per record and reads them back in append order', async () => {
    await appendEngineerReport(dir, input(), testLocalWriteAuthority('evidence', dir));
    await appendEngineerReport(dir, input({ reportId: 'rep_2' }), testLocalWriteAuthority('evidence', dir));

    const lines = readFileSync(join(dir, 'engineer-reports.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(listEngineerReports(dir).map((r) => r.reportId)).toEqual(['rep_1', 'rep_2']);
  });

  it('verifies a clean chain', async () => {
    await appendEngineerReport(dir, input(), testLocalWriteAuthority('evidence', dir));
    await appendEngineerReport(dir, input({ reportId: 'rep_2' }), testLocalWriteAuthority('evidence', dir));

    expect(verifyReportChain(dir)).toEqual({ ok: true, length: 2 });
  });

  it('verifies an empty ledger directory as a zero-length clean chain', async () => {
    expect(verifyReportChain(dir)).toEqual({ ok: true, length: 0 });
  });

  it('detects tampering when a persisted verdict is edited in place', async () => {
    await appendEngineerReport(dir, input(), testLocalWriteAuthority('evidence', dir));
    await appendEngineerReport(dir, input({ reportId: 'rep_2' }), testLocalWriteAuthority('evidence', dir));

    const path = join(dir, 'engineer-reports.jsonl');
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    lines[0] = lines[0].replace('"verdict":"FAIL"', '"verdict":"PASS"');
    writeFileSync(path, `${lines.join('\n')}\n`);

    const result = verifyReportChain(dir);
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(1);
    expect(result.reason).toMatch(/hash/i);
  });

  it('detects a removed record (chain link break), not just a rewritten one', async () => {
    await appendEngineerReport(dir, input(), testLocalWriteAuthority('evidence', dir));
    await appendEngineerReport(dir, input({ reportId: 'rep_2' }), testLocalWriteAuthority('evidence', dir));
    await appendEngineerReport(dir, input({ reportId: 'rep_3' }), testLocalWriteAuthority('evidence', dir));

    const path = join(dir, 'engineer-reports.jsonl');
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    writeFileSync(path, `${lines[0]}\n${lines[2]}\n`);

    const result = verifyReportChain(dir);
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(2);
  });
});

describe('@sangfor/engineer-report — anti-overrule gate', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'engineer-report-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('accepts a report whose engineResult deep-equals the reference engine output', async () => {
    const { report } = await appendEngineerReport(dir, input(), testLocalWriteAuthority('evidence', dir));
    const reference: EvaluationResult = JSON.parse(JSON.stringify(engineResult)) as EvaluationResult;

    expect(validateEngineerReport(report, reference)).toEqual({ ok: true });
  });

  it('refuses a report whose verdict was flipped away from the engine output', async () => {
    const overruled: EvaluationResult = JSON.parse(JSON.stringify(engineResult)) as EvaluationResult;
    (overruled.items[0] as { verdict: 'PASS' }).verdict = 'PASS';
    const { report } = await appendEngineerReport(dir, input({ engineResult: overruled }), testLocalWriteAuthority('evidence', dir));

    const result = validateEngineerReport(report, engineResult);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/engineResult/i);
    expect(result.mismatchedItemIds).toEqual(['ssl_inspection_enabled']);
  });

  it('refuses a report whose summary counters were massaged even when verdicts match', async () => {
    const massaged: EvaluationResult = JSON.parse(JSON.stringify(engineResult)) as EvaluationResult;
    massaged.summary = { ...massaged.summary, fail: 0, pass: 2 };
    const { report } = await appendEngineerReport(dir, input({ engineResult: massaged }), testLocalWriteAuthority('evidence', dir));

    const result = validateEngineerReport(report, engineResult);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/engineResult/i);
  });

  it('refuses a report that drops or invents engine items', async () => {
    const truncated: EvaluationResult = JSON.parse(JSON.stringify(engineResult)) as EvaluationResult;
    truncated.items = [truncated.items[1]];
    const { report } = await appendEngineerReport(dir, input({ engineResult: truncated }), testLocalWriteAuthority('evidence', dir));

    const result = validateEngineerReport(report, engineResult);
    expect(result.ok).toBe(false);
    expect(result.mismatchedItemIds).toEqual(['ssl_inspection_enabled']);
  });

  it('treats agent prose as annotation only — it never affects the gate', async () => {
    const { report } = await appendEngineerReport(dir, input({
      riskNote: '엔진이 틀렸다고 생각함 — 실제로는 정상',
      recommendations: ['무시해도 됨'],
    }), testLocalWriteAuthority('evidence', dir));

    expect(validateEngineerReport(report, engineResult)).toEqual({ ok: true });
  });
});

describe('@sangfor/engineer-report — reproducibility', () => {
  let dirA: string;
  let dirB: string;
  beforeEach(() => {
    dirA = mkdtempSync(join(tmpdir(), 'engineer-report-a-'));
    dirB = mkdtempSync(join(tmpdir(), 'engineer-report-b-'));
  });
  afterEach(() => {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  it('produces the same record hash for the same report in two separate ledgers', async () => {
    const a = await appendEngineerReport(dirA, input(), testLocalWriteAuthority('evidence', dirA));
    const b = await appendEngineerReport(dirB, input(), testLocalWriteAuthority('evidence', dirB));

    expect(a.record.hash).toBe(b.record.hash);
  });

  it('canonicalizes key order so a reordered input yields the same hash', async () => {
    const reordered: EngineerReportInput = {
      ...input(),
      engineResult: {
        summary: engineResult.summary,
        coverage: engineResult.coverage,
        items: engineResult.items,
        ok: engineResult.ok,
        specId: engineResult.specId,
      },
    };
    const a = await appendEngineerReport(dirA, input(), testLocalWriteAuthority('evidence', dirA));
    const b = await appendEngineerReport(dirB, reordered, testLocalWriteAuthority('evidence', dirB));

    expect(b.record.hash).toBe(a.record.hash);
  });

  it('changes the hash when the prompt hash changes (same snapshot, different prompt)', async () => {
    const a = await appendEngineerReport(dirA, input(), testLocalWriteAuthority('evidence', dirA));
    const b = await appendEngineerReport(dirB, input({ promptHash: 'c'.repeat(64) }), testLocalWriteAuthority('evidence', dirB));

    expect(b.record.hash).not.toBe(a.record.hash);
  });

  it('exposes an engineResult that is readonly at compile time and frozen at runtime', async () => {
    const { report }: { report: EngineerReport } = await appendEngineerReport(dirA, input(), testLocalWriteAuthority('evidence', dirA));

    expect(() => {
      // @ts-expect-error engineResult is readonly — reports never overrule the engine
      report.engineResult = engineResult;
    }).toThrow(TypeError);
    expect(report.engineResult.items[0].verdict).toBe('FAIL');
  });
});
