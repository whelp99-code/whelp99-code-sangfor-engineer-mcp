import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nowId, expectedLocalWriteScope, requireLocalWriteAuthority, resolveRepoData, withDirLock, writeFileAtomicSync, type LocalWriteAuthority } from '../../../packages/shared/src/index.js';
import type { NamedRuntimeCodec } from '../../../packages/shared/src/runtime-schema.js';
import {
  deviceRegistryCodec,
  parseBoundaryControlTowerRegistryV1,
  vendorRegistryCodec,
} from './runtime-boundaries.js';

export interface VendorDescriptor {
  product: string;             // 열린 값 (enum 아님)
  label: string;
  advisorTools: string[];      // 이 벤더 장비에 실행할 읽기전용 자문 도구 전체이름
  credentialFields: string[];  // 자문 도구가 요구하는 장비 인자 이름들
  defaultArgs?: Record<string, unknown>;
}

export interface Device {
  id: string;
  name: string;
  product: string;             // vendors.json의 product 참조 (등록 시 검증)
  host: string;
  tags: string[];
  credentialEnv?: Record<string, string>; // 값은 env 변수 "이름" — 비밀값 파일 저장 금지
  createdAt: string;
  updatedAt: string;
}

export class RegistryValidationError extends Error {}

// NOTE: 스펙 §5.4 시드의 HCI credentialFields 'identityUrl'은 실제 스키마 속성명
// 'identityBaseUrl'로 교정했다 (tests/control-tower-e2e.test.ts T-INT-2가 대조 고정).
export const SEED_VENDORS: VendorDescriptor[] = [
  {
    product: 'FORTIOS', label: 'Fortinet FortiOS',
    advisorTools: ['sangfor_advisor_fortios', 'sangfor_advisor_fortios_advanced'],
    credentialFields: ['host', 'username', 'password'],
    defaultArgs: { specVersion: '8.0.0' },
  },
  {
    product: 'CISCO_IOSXE', label: 'Cisco IOS-XE',
    advisorTools: ['sangfor_advisor_cisco_iosxe', 'sangfor_advisor_cisco_iosxe_advanced'],
    credentialFields: ['host', 'username', 'password'],
    defaultArgs: { specVersion: '17.0.0' },
  },
  {
    product: 'HCI_SCP', label: 'Sangfor HCI/SCP',
    advisorTools: ['sangfor_hci_health_report'],
    credentialFields: ['identityBaseUrl', 'username', 'password'],
    defaultArgs: {},
  },
];

export class Registry {
  private readonly dir: string;
  private readonly authority: LocalWriteAuthority;

  constructor(dir: string | undefined, authority: LocalWriteAuthority) {
    this.dir = dir ?? resolveRepoData('data/registry', 'SANGFOR_REGISTRY_ROOT');
    this.authority = requireLocalWriteAuthority(authority, expectedLocalWriteScope(
      authority, authority?.projectId ?? '', 'registry_services', this.dir,
    ));
  }

  vendors(): VendorDescriptor[] {
    return this.loadOrSeed(join(this.dir, 'vendors.json'), SEED_VENDORS, vendorRegistryCodec);
  }

  async seedVendors(): Promise<VendorDescriptor[]> {
    const path = join(this.dir, 'vendors.json');
    return this.authority.fence.write(this.authority, { operation: 'registry.seed-vendors', targetPaths: [path] }, () => {
      this.atomicWrite(path, SEED_VENDORS);
      return structuredClone(SEED_VENDORS);
    });
  }

  vendorFor(product: string): VendorDescriptor | undefined {
    return this.vendors().find((v) => v.product === product);
  }

  devices(): Device[] {
    return this.loadOrSeed(join(this.dir, 'devices.json'), [], deviceRegistryCodec);
  }

  // devices.json's own read-modify-write sequence (existence check → mutate →
  // write) is not atomic on its own — two concurrent createDevice/updateDevice/
  // deleteDevice calls could each read the same snapshot and clobber one
  // another's write. Every mutator below holds this lock for its full body.
  private get devicesLockPath(): string {
    return join(this.dir, 'devices.json.lock');
  }

  async createDevice(input: {
    name: string; product: string; host: string;
    tags?: string[]; credentialEnv?: Record<string, string>;
  }): Promise<Device> {
    return this.authority.fence.write(this.authority, { operation: 'registry.create-device', targetPaths: [join(this.dir, 'devices.json')] }, () => withDirLock(this.devicesLockPath, () => {
      if (!input.name?.trim()) throw new RegistryValidationError('name is required');
      if (!input.host?.trim()) throw new RegistryValidationError('host is required');
      if (!this.vendorFor(input.product)) throw new RegistryValidationError(`unknown product (vendors.json에 없음): ${input.product}`);
      const now = new Date().toISOString();
      const device: Device = {
        id: nowId('dev'), name: input.name.trim(), product: input.product, host: input.host.trim(),
        tags: input.tags ?? [], createdAt: now, updatedAt: now,
      };
      if (input.credentialEnv) device.credentialEnv = input.credentialEnv;
      this.writeDevices([...this.devices(), device]);
      return device;
    }));
  }

  async updateDevice(id: string, patch: Partial<Omit<Device, 'id' | 'createdAt' | 'updatedAt'>>): Promise<Device> {
    return this.authority.fence.write(this.authority, { operation: 'registry.update-device', targetPaths: [join(this.dir, 'devices.json')] }, () => withDirLock(this.devicesLockPath, () => {
      const devices = this.devices();
      const index = devices.findIndex((device) => device.id === id);
      if (index === -1) throw new RegistryValidationError(`unknown device: ${id}`);
      const current = devices[index];
      if (!current) throw new RegistryValidationError(`unknown device: ${id}`);
      if (patch.product !== undefined && !this.vendorFor(patch.product)) throw new RegistryValidationError(`unknown product (vendors.json에 없음): ${patch.product}`);
      const updated: Device = { ...current, ...patch, id, createdAt: current.createdAt, updatedAt: new Date().toISOString() };
      devices[index] = updated;
      this.writeDevices(devices);
      return updated;
    }));
  }

  async deleteDevice(id: string): Promise<void> {
    await this.authority.fence.write(this.authority, { operation: 'registry.delete-device', targetPaths: [join(this.dir, 'devices.json')] }, () => withDirLock(this.devicesLockPath, () => {
      const devices = this.devices();
      if (!devices.some((device) => device.id === id)) throw new RegistryValidationError(`unknown device: ${id}`);
      this.writeDevices(devices.filter((device) => device.id !== id));
    }));
  }

  private loadOrSeed<T>(path: string, seed: T, codec: NamedRuntimeCodec<T>): T {
    try {
      return parseBoundaryControlTowerRegistryV1(readFileSync(path, 'utf8'), codec);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(seed);
      throw error; // corrupt registry must fail loud, not silently reset
    }
  }

  private writeDevices(devices: Device[]): void {
    this.atomicWrite(join(this.dir, 'devices.json'), devices);
  }

  private atomicWrite(path: string, value: unknown): void {
    writeFileAtomicSync(path, JSON.stringify(value, null, 2));
  }
}

// 인자 병합 우선순위: defaultArgs < device.host < credentialEnv 해석값 < 사용자입력.
export function mergeDeviceArgs(
  vendor: VendorDescriptor,
  device: Device,
  userArgs: Record<string, unknown> = {},
): Record<string, unknown> {
  const fromEnv: Record<string, unknown> = {};
  for (const [field, envName] of Object.entries(device.credentialEnv ?? {})) {
    const value = process.env[envName];
    if (value !== undefined) fromEnv[field] = value;
  }
  return { ...(vendor.defaultArgs ?? {}), host: device.host, ...fromEnv, ...userArgs };
}

// mock 장비 폴백: 도구 inputSchema가 required로 요구하는 credentialField가 병합 후에도
// 없으면 'mock'을 채운다 (mock 콘솔은 인증을 보지 않는다). required가 아니면 채우지
// 않는다 — HCI identityBaseUrl은 도구 기본값(로컬 mock)을 그대로 쓰게 한다.
export function applyMockCredentialFallback(
  args: Record<string, unknown>,
  vendor: VendorDescriptor,
  inputSchema: { required?: string[] } | undefined,
): Record<string, unknown> {
  const required = new Set(inputSchema?.required ?? []);
  const out = { ...args };
  for (const field of vendor.credentialFields) {
    if (out[field] === undefined && required.has(field)) out[field] = 'mock';
  }
  return out;
}
