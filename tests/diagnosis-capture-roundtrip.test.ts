import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readDiagnosisCapture,
  writeDiagnosisCaptureFromPool,
  type DiagnosisProduct,
} from '../scripts/diagnosis-bundle-io.js';

const DEVICE_SCOPE = '018f22e2-79b0-7cc3-8c3c-0f8e5d50a2bf';

describe('PR-004 device writer and diagnosis readers share capture-bundle.v1', () => {
  let root: string;
  const keyring = { activeKeyId: 'key-1', keys: { 'key-1': Buffer.alloc(32, 0x42) } };
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'diagnosis-capture-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  for (const [product, pool] of [
    ['EPP', { 'POST /api/edrgoweb/v1/patch/statistics': { isLatest: true } }],
    ['CC', { 'POST /apps/secvisual/system/system_manage/get_system_info': { system_version: '3.0.98', timezone: 'Asia/Seoul' } }],
    ['IAG', { 'GET /api/structure': { routeCount: 4 } }],
  ] as Array<[DiagnosisProduct, Record<string, unknown>]>) {
    it(`${product} writer round-trips through the canonical diagnosis reader`, () => {
      const summary = writeDiagnosisCaptureFromPool({
        product,
        pool,
        deviceScope: DEVICE_SCOPE,
        keyring,
        capturesDir: join(root, 'captures'),
        stagingRoot: join(root, 'staging'),
        capturedAt: new Date('2026-07-28T00:00:00.000Z'),
      });
      const payload = readDiagnosisCapture(summary.path, keyring, product);
      expect(payload.product).toBe(product);
      expect(payload.endpointsCaptured).toBe(Object.keys(pool).length);
      expect(payload.kind).toBe('diagnosis-config-state.v1');
      if (product === 'EPP') expect(payload.observed.patchIsLatest?.value).toBe(true);
      if (product === 'CC') expect(payload.observed.systemVersion?.value).toBe('3.0.98');
      if (product === 'IAG') expect(payload.observed).toEqual({});
    });
  }

  it('refuses a product-mismatched reader', () => {
    const summary = writeDiagnosisCaptureFromPool({
      product: 'EPP', pool: {}, deviceScope: DEVICE_SCOPE, keyring,
      capturesDir: join(root, 'captures'), stagingRoot: join(root, 'staging'),
    });
    expect(() => readDiagnosisCapture(summary.path, keyring, 'CC')).toThrow(/INVALID_DIAGNOSIS_CAPTURE/u);
  });
});
