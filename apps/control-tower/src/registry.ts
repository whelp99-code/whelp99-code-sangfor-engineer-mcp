import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nowId, resolveRepoData } from '../../../packages/shared/src/index.js';

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
    advisorTools: ['sangfor.advisor_fortios', 'sangfor.advisor_fortios_advanced'],
    credentialFields: ['host', 'username', 'password'],
    defaultArgs: { specVersion: '8.0.0' },
  },
  {
    product: 'CISCO_IOSXE', label: 'Cisco IOS-XE',
    advisorTools: ['sangfor.advisor_cisco_iosxe', 'sangfor.advisor_cisco_iosxe_advanced'],
    credentialFields: ['host', 'username', 'password'],
    defaultArgs: { specVersion: '17.0.0' },
  },
  {
    product: 'HCI_SCP', label: 'Sangfor HCI/SCP',
    advisorTools: ['sangfor.hci_health_report'],
    credentialFields: ['identityBaseUrl', 'username', 'password'],
    defaultArgs: {},
  },
];

export class Registry {
  private readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? resolveRepoData('data/registry', 'SANGFOR_REGISTRY_ROOT');
  }

  vendors(): VendorDescriptor[] {
    return this.loadOrSeed<VendorDescriptor[]>(join(this.dir, 'vendors.json'), SEED_VENDORS);
  }

  vendorFor(product: string): VendorDescriptor | undefined {
    return this.vendors().find((v) => v.product === product);
  }

  devices(): Device[] {
    return this.loadOrSeed<Device[]>(join(this.dir, 'devices.json'), []);
  }

  createDevice(input: {
    name: string; product: string; host: string;
    tags?: string[]; credentialEnv?: Record<string, string>;
  }): Device {
    if (!input.name?.trim()) throw new RegistryValidationError('name is required');
    if (!input.host?.trim()) throw new RegistryValidationError('host is required');
    if (!this.vendorFor(input.product)) {
      throw new RegistryValidationError(`unknown product (vendors.json에 없음): ${input.product}`);
    }
    const now = new Date().toISOString();
    const device: Device = {
      id: nowId('dev'),
      name: input.name.trim(),
      product: input.product,
      host: input.host.trim(),
      tags: input.tags ?? [],
      createdAt: now,
      updatedAt: now,
    };
    if (input.credentialEnv) device.credentialEnv = input.credentialEnv;
    this.writeDevices([...this.devices(), device]);
    return device;
  }

  updateDevice(id: string, patch: Partial<Omit<Device, 'id' | 'createdAt' | 'updatedAt'>>): Device {
    const devices = this.devices();
    const index = devices.findIndex((d) => d.id === id);
    if (index === -1) throw new RegistryValidationError(`unknown device: ${id}`);
    if (patch.product !== undefined && !this.vendorFor(patch.product)) {
      throw new RegistryValidationError(`unknown product (vendors.json에 없음): ${patch.product}`);
    }
    const updated: Device = {
      ...devices[index],
      ...patch,
      id,
      createdAt: devices[index].createdAt,
      updatedAt: new Date().toISOString(),
    };
    devices[index] = updated;
    this.writeDevices(devices);
    return updated;
  }

  deleteDevice(id: string): void {
    const devices = this.devices();
    if (!devices.some((d) => d.id === id)) throw new RegistryValidationError(`unknown device: ${id}`);
    this.writeDevices(devices.filter((d) => d.id !== id));
  }

  private loadOrSeed<T>(path: string, seed: T): T {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.atomicWrite(path, seed);
        return structuredClone(seed);
      }
      throw error; // corrupt registry must fail loud, not silently reset
    }
  }

  private writeDevices(devices: Device[]): void {
    this.atomicWrite(join(this.dir, 'devices.json'), devices);
  }

  private atomicWrite(path: string, value: unknown): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, path);
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
