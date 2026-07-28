import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LearningStrategyService } from '../packages/sangfor-learning-strategy/src/service.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function service(): LearningStrategyService {
  const root = mkdtempSync(join(tmpdir(), 'strategy-service-'));
  roots.push(root);
  return new LearningStrategyService(root);
}

describe('LearningStrategyService', () => {
  it('persists a researched draft and lists it through exact filters', () => {
    const subject = service();
    const created = subject.research({
      strategyId: 'endpoint-version', vendor: 'SANGFOR',
      scope: { product: 'ENDPOINT_SECURE', firmwareVersion: '6.0.4', fact: 'version' },
      registryDigest: 'a'.repeat(64), versionTruthRecord: 'truth-604',
      officialCitation: 'https://support.example.invalid/manual', pageVerified: true,
    });
    expect(created.revision.state).toBe('draft');
    expect(created.evidenceGaps).toEqual(['capture evidence is not supplied']);
    expect(subject.list({ product: 'ENDPOINT_SECURE', firmwareVersion: '6.0.4' }).items).toHaveLength(1);
  });

  it('fails closed on registry drift and never returns a near product match', () => {
    const subject = service();
    subject.research({
      strategyId: 'endpoint-version', vendor: 'SANGFOR',
      scope: { product: 'ENDPOINT_SECURE', firmwareVersion: '6.0.4' },
      registryDigest: 'a'.repeat(64), versionTruthRecord: 'truth-604',
      officialCitation: 'https://support.example.invalid/manual', pageVerified: true,
    });
    expect(subject.resolve(
      { product: 'ENDPOINT_SECURE', firmwareVersion: '6.0.4' },
      { registryDigest: 'b'.repeat(64), versionTruthRecord: 'truth-604', environment: 'lab' },
    )).toMatchObject({ code: 'REGISTRY_DRIFT' });
    expect(subject.resolve(
      { product: 'ENDPOINT_SECURE', firmwareVersion: '6.0.5' },
      { registryDigest: 'a'.repeat(64), versionTruthRecord: 'truth-604', environment: 'lab' },
    )).toMatchObject({ code: 'NO_ELIGIBLE_STRATEGY' });
  });

  it('rejects credential fields recursively', () => {
    const subject = service();
    expect(() => subject.resolve(
      { product: 'ENDPOINT_SECURE', firmwareVersion: '6.0.4', password: 'x' } as never,
      { registryDigest: 'a'.repeat(64), versionTruthRecord: 'truth' },
    )).toThrow('SECRET_FIELD_FORBIDDEN');
  });
});
