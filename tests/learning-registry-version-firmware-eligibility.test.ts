import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isFirmwareTruthEligible,
  resolveVerifiedFirmwareIdentity,
  transitionFirmwareTruthStatus,
} from '../packages/sangfor-learning-strategy/src/index.js';
import { getProductRegistrySnapshot } from '../packages/sangfor-product-adapters/src/index.js';
import {
  loadFirmwareTruthRecords,
  parseFirmwareTruthRecord,
  toFirmwareIdentity,
  type FirmwareTruthRecord,
} from '../packages/sangfor-version/src/index.js';

describe('PR-001A1 firmware truth eligibility and transitions', () => {
  it('loads conflict seeds without making CC versions eligible for Spec input', () => {
    const records = loadFirmwareTruthRecords();
    const cc = records.filter((record) => record.adapterProduct === 'NDR');
    expect(cc.map((record) => record.versionRaw)).toEqual(['3.0.98', '3.0.98C']);
    expect(cc.every((record) => record.status === 'conflict')).toBe(true);
    expect(cc.every((record) => !isFirmwareTruthEligible(record))).toBe(true);
  });

  it('allows only forward truth-state transitions and requires confined regular evidence for verified eligibility', () => {
    const root = join(tmpdir(), `learning-version-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const outsideRoot = `${root}-outside`;
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'evidence.json'), '{"ok":true}\n');
    mkdirSync(join(root, 'directory'), { recursive: true });
    mkdirSync(outsideRoot, { recursive: true });
    writeFileSync(join(outsideRoot, 'outside.json'), '{"outside":true}\n');
    symlinkSync(join(outsideRoot, 'outside.json'), join(root, 'symlink.json'));
    const candidate: FirmwareTruthRecord = parseFirmwareTruthRecord({
      id: 'fixture-candidate',
      vendor: 'FORTINET',
      adapterProduct: 'FORTIOS',
      productVariant: null,
      versionRaw: '8.0.0',
      versionFamily: '8.0',
      revision: null,
      buildId: 'forti-build',
      hotfix: null,
      uiFingerprint: null,
      apiFingerprint: null,
      status: 'candidate',
      observedAt: '2026-07-23T00:00:00.000Z',
      evidenceFile: 'evidence.json',
      specVersion: '8.0.0',
      specApplicability: 'unreviewed',
      source: 'test fixture',
    });
    const conflict = transitionFirmwareTruthStatus(candidate, 'conflict');
    expect(() => transitionFirmwareTruthStatus(conflict, 'candidate')).toThrow('INVALID_VERSION_TRUTH_TRANSITION');
    const superseded = transitionFirmwareTruthStatus(conflict, 'superseded');
    expect(() => transitionFirmwareTruthStatus(superseded, 'verified')).toThrow('INVALID_VERSION_TRUTH_TRANSITION');

    const verified = transitionFirmwareTruthStatus(candidate, 'verified', { specApplicability: 'verified' });
    expect(isFirmwareTruthEligible(verified)).toBe(false);
    expect(isFirmwareTruthEligible(verified, { evidenceRoot: root })).toBe(true);
    for (const evidenceFile of ['', '/etc/hosts', 'C:\\outside.json', '../evidence.json', 'foo/../../evidence.json', 'missing.json', 'directory', 'symlink.json']) {
      expect(isFirmwareTruthEligible({ ...verified, evidenceFile }, { evidenceRoot: root })).toBe(false);
    }
    for (const specVersion of ['../EPP/6.0.4', 'EPP/6.0.4', 'EPP\\6.0.4', '.', '..', '6.0.4 ']) {
      expect(isFirmwareTruthEligible({ ...verified, specVersion }, { evidenceRoot: root })).toBe(false);
    }
    expect(() => resolveVerifiedFirmwareIdentity(
      { ...verified, specVersion: '../EPP/6.0.4' },
      getProductRegistrySnapshot(),
      { evidenceRoot: root },
    )).toThrow('INVALID_FIRMWARE_TRUTH');
    expect(toFirmwareIdentity(verified)).toMatchObject({ adapterProduct: 'FORTIOS', buildId: 'forti-build', specVersion: '8.0.0' });
    expect(resolveVerifiedFirmwareIdentity(verified, getProductRegistrySnapshot(), { evidenceRoot: root }).adapterProduct).toBe('FORTIOS');
    expect(() => resolveVerifiedFirmwareIdentity(
      { ...verified, vendor: 'CISCO' },
      getProductRegistrySnapshot(),
      { evidenceRoot: root },
    )).toThrow('SPEC_IDENTITY_MISMATCH');
    expect(() => Reflect.apply(resolveVerifiedFirmwareIdentity, undefined, [null, getProductRegistrySnapshot(), { evidenceRoot: root }])).toThrow('INVALID_FIRMWARE_TRUTH');
    const incomplete = { status: 'conflict' } satisfies { readonly status: string };
    expect(() => Reflect.apply(resolveVerifiedFirmwareIdentity, undefined, [incomplete, getProductRegistrySnapshot(), { evidenceRoot: root }])).toThrow('INVALID_FIRMWARE_TRUTH');
  });
});
