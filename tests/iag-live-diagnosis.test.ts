import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  diagnoseIagLiveObservation,
  mapIagLiveObservationToFacts,
  parseIagLiveObservation,
} from '../scripts/iag-live-observation.js';
import {
  diagnoseIagLiveInputText,
  parseIagDiagnoseLiveArgs,
  writeIagLiveDiagnosisOutput,
} from '../scripts/iag-diagnose-live.js';

const full = {
  schemaVersion: 'iag-live-observation.v1', product: 'IAG', firmwareVersion: '13.0.120',
  observed: { logRetentionDays: 180, webAuthEnabled: true, credentialWebAuthEnabled: false, dot1xEnabled: false, securityEventsCount: 0, haEnabled: false },
  observedAt: '2026-07-29T00:00:00.000Z', evidenceSource: 'field engineer read-only console observation',
};

describe('IAG live diagnosis bridge', () => {
  it('maps complete sanitized observations to manual provenance and evaluates the merged spec', () => {
    const diagnosis = diagnoseIagLiveObservation(full);
    expect(diagnosis.result.summary).toMatchObject({ pass: 3, missing: 1, contextDependent: 2, indeterminate: 0 });
    expect(mapIagLiveObservationToFacts(diagnosis.observation).webAuthEnabled).toEqual({
      value: true,
      source: { collector: 'manual', collectedAt: full.observedAt, endpoint: expect.stringContaining('Web Authentication') },
    });
    expect(diagnosis.report).toContain('Live observation provenance (sanitized, read-only)');
    expect(diagnosis.report).not.toMatch(/[ \t]+$/mu);
  });

  it('keeps omitted observations INDETERMINATE instead of defaulting them', () => {
    const diagnosis = diagnoseIagLiveObservation({ ...full, observed: { webAuthEnabled: true } });
    expect(diagnosis.result.summary.indeterminate).toBeGreaterThan(0);
    expect(diagnosis.result.coverage.unobservedItems).toContain('log_retention_days');
  });

  it('rejects unknown fields and invalid types or product/version context', () => {
    expect(() => parseIagLiveObservation({ ...full, unexpected: true })).toThrow(/unknown top-level/i);
    expect(() => parseIagLiveObservation({ ...full, observed: { typo: true } })).toThrow(/unknown observed/i);
    expect(() => parseIagLiveObservation({ ...full, observed: { logRetentionDays: -1 } })).toThrow(/nonnegative safe integer/i);
    expect(() => parseIagLiveObservation({ ...full, evidenceSource: 'trusted\n- forged finding' })).toThrow(/printable ASCII/i);
    expect(() => parseIagLiveObservation({ ...full, product: 'SWG' })).toThrow(/product/i);
    expect(() => parseIagLiveObservation({ ...full, firmwareVersion: '13.0.121' })).toThrow(/firmwareVersion/i);
  });

  it('writes a deterministic report requested by the CLI helper', () => {
    const directory = mkdtempSync(join(tmpdir(), 'iag-live-diagnosis-'));
    try {
      const input = join(directory, 'input.json');
      const output = join(directory, 'report.md');
      writeFileSync(input, JSON.stringify(full));
      expect(parseIagDiagnoseLiveArgs(['--input', input, '--output', output])).toEqual({ input, output });
      const report = diagnoseIagLiveInputText(readFileSync(input, 'utf8')).report;
      writeIagLiveDiagnosisOutput(output, report);
      expect(readFileSync(output, 'utf8')).toBe(report);
      expect(report).toContain(full.observedAt);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
