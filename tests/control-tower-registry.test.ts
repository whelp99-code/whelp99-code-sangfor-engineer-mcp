import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  Registry, RegistryValidationError, SEED_VENDORS,
  mergeDeviceArgs, applyMockCredentialFallback,
  type Device, type VendorDescriptor,
} from '../apps/control-tower/src/registry.js';

describe('Registry — 로드/시드/CRUD (T-REG-1)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'registry-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('vendors.json 없으면 시드 3종을 생성하고 반환한다', () => {
    const reg = new Registry(dir);
    const vendors = reg.vendors();
    expect(vendors.map((v) => v.product)).toEqual(['FORTIOS', 'CISCO_IOSXE', 'HCI_SCP']);
    expect(existsSync(join(dir, 'vendors.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'vendors.json'), 'utf8'))).toEqual(SEED_VENDORS);
  });

  it('HCI 시드 credentialFields는 실제 스키마 속성명 identityBaseUrl을 쓴다 (스펙 교정 1)', () => {
    const hci = SEED_VENDORS.find((v) => v.product === 'HCI_SCP')!;
    expect(hci.credentialFields).toEqual(['identityBaseUrl', 'username', 'password']);
  });

  it('devices CRUD: 생성/수정/삭제 + atomic 파일 반영 + 재로드', () => {
    const reg = new Registry(dir);
    const dev = reg.createDevice({ name: '본사 FW', product: 'FORTIOS', host: '10.0.0.1', tags: ['lab'] });
    expect(dev.id).toMatch(/^dev_/);
    expect(new Registry(dir).devices()).toHaveLength(1);
    const updated = reg.updateDevice(dev.id, { name: '본사 FW 1호기' });
    expect(updated.name).toBe('본사 FW 1호기');
    expect(updated.updatedAt >= dev.updatedAt).toBe(true);
    reg.deleteDevice(dev.id);
    expect(reg.devices()).toHaveLength(0);
    expect(existsSync(join(dir, 'devices.json.tmp'))).toBe(false); // atomic write 잔여물 없음
  });

  it('vendors.json에 없는 product 등록/수정은 RegistryValidationError', () => {
    const reg = new Registry(dir);
    expect(() => reg.createDevice({ name: 'x', product: 'NOPE', host: 'h' })).toThrow(RegistryValidationError);
    const dev = reg.createDevice({ name: 'x', product: 'FORTIOS', host: 'h' });
    expect(() => reg.updateDevice(dev.id, { product: 'NOPE' })).toThrow(/unknown product/);
    expect(() => reg.updateDevice(dev.id, { product: '' })).toThrow(/unknown product/);
    expect(() => reg.updateDevice('dev_none', { name: 'y' })).toThrow(/unknown device/);
    expect(() => reg.deleteDevice('dev_none')).toThrow(/unknown device/);
    expect(() => reg.createDevice({ name: '', product: 'FORTIOS', host: 'h' })).toThrow(/name is required/);
    expect(() => reg.createDevice({ name: 'x', product: 'FORTIOS', host: ' ' })).toThrow(/host is required/);
  });
});

describe('mergeDeviceArgs — 병합 우선순위 (T-REG-2)', () => {
  const vendor: VendorDescriptor = {
    product: 'FORTIOS', label: 'f', advisorTools: [],
    credentialFields: ['host', 'username', 'password'],
    defaultArgs: { specVersion: '8.0.0', host: 'default-host' },
  };
  const device: Device = {
    id: 'dev_1', name: 'n', product: 'FORTIOS', host: '10.0.0.9', tags: [],
    credentialEnv: { username: 'T_REG2_USER', password: 'T_REG2_PASS' },
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };

  afterEach(() => { delete process.env.T_REG2_USER; delete process.env.T_REG2_PASS; });

  it('defaultArgs < device.host < credentialEnv < 사용자입력', () => {
    process.env.T_REG2_USER = 'env-admin';
    process.env.T_REG2_PASS = 'env-pass';
    const merged = mergeDeviceArgs(vendor, device, { password: 'user-wins' });
    expect(merged).toEqual({
      specVersion: '8.0.0',
      host: '10.0.0.9',        // device.host가 defaultArgs.host를 덮음
      username: 'env-admin',   // env 해석값
      password: 'user-wins',   // 사용자 입력 최우선
    });
  });

  it('credentialEnv의 env 변수가 없으면 해당 키는 생략된다', () => {
    const merged = mergeDeviceArgs(vendor, device, {});
    expect(merged.username).toBeUndefined();
    expect(merged.password).toBeUndefined();
  });

  it('applyMockCredentialFallback: 스키마 required인 credentialField만 mock으로 채운다', () => {
    const merged = mergeDeviceArgs(vendor, device, {});
    const filled = applyMockCredentialFallback(merged, vendor, { required: ['host', 'username', 'password'] });
    expect(filled.username).toBe('mock');
    expect(filled.password).toBe('mock');
    // required 아니면 채우지 않는다 (HCI identityBaseUrl 케이스)
    const hciVendor: VendorDescriptor = { product: 'HCI_SCP', label: 'h', advisorTools: [], credentialFields: ['identityBaseUrl', 'username', 'password'] };
    const untouched = applyMockCredentialFallback({}, hciVendor, { required: [] });
    expect(untouched).toEqual({});
    // 이미 값이 있으면 덮지 않는다
    const kept = applyMockCredentialFallback({ username: 'real' }, vendor, { required: ['username'] });
    expect(kept.username).toBe('real');
  });
});

describe('개방성 — 가상 벤더 주입 (T-REG-3)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'registry-acme-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('ACME_FW 디스크립터를 파일로 주입하면 코드 수정 없이 등록·인자구성이 동작한다', () => {
    const acme: VendorDescriptor = {
      product: 'ACME_FW', label: 'Acme Firewall',
      advisorTools: ['sangfor.advisor_acme'],
      credentialFields: ['host', 'apiKey'],
      defaultArgs: { profile: 'strict' },
    };
    writeFileSync(join(dir, 'vendors.json'), JSON.stringify([acme], null, 2));
    const reg = new Registry(dir);
    const dev = reg.createDevice({ name: 'acme1', product: 'ACME_FW', host: 'http://127.0.0.1:9999', tags: [] });
    const args = applyMockCredentialFallback(
      mergeDeviceArgs(reg.vendorFor(dev.product)!, dev, {}),
      reg.vendorFor(dev.product)!,
      { required: ['host', 'apiKey'] },
    );
    expect(args).toEqual({ profile: 'strict', host: 'http://127.0.0.1:9999', apiKey: 'mock' });
  });
});
