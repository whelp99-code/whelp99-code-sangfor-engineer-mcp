import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRepoData } from '../../shared/src/index.js';

export type SafetyClass = 'auto_allowed' | 'read_only' | 'human_only';
export type MaturityLevel = 'planned' | 'implemented_local' | 'tested_mock' | 'field_verified';

export interface SafetyEntry {
  product: string;
  capabilityId: string;
  safetyClass: SafetyClass;
  reason: string;
}

export interface MaturityEntry {
  product: string;
  capabilityId: string;
  maturity: MaturityLevel;
  evidence: string;
}

export interface SafetyPolicy {
  version: number;
  defaultSafetyClass: SafetyClass;
  entries: SafetyEntry[];
}

export interface MaturityPolicy {
  version: number;
  entries: MaturityEntry[];
}

export interface CapabilitySafetySummary {
  product: string;
  capabilityId: string;
  safetyClass: SafetyClass;
  maturity: MaturityLevel;
  autoAllowed: boolean;
  fieldVerifiedAutoAllowed: boolean;
  reason: string;
  evidence?: string;
}

const DEFAULT_DATA_ROOT = resolveRepoData('data', 'SANGFOR_DATA_ROOT');
const SAFETY_PATH = 'safety/capability-safety.json';
const MATURITY_PATH = 'competency/capability-maturity.json';

export function loadSafetyPolicy(dataRoot: string = DEFAULT_DATA_ROOT): SafetyPolicy {
  const path = join(dataRoot, SAFETY_PATH);
  const deny: SafetyPolicy = { version: 1, defaultSafetyClass: 'human_only', entries: [] };
  if (!existsSync(path)) return deny;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SafetyPolicy;
  } catch {
    // A corrupt safety policy must fail SAFE (deny / human_only), never crash the gate.
    process.stderr.write('[safety] unparseable capability-safety.json — defaulting to human_only deny\n');
    return deny;
  }
}

export function loadMaturityPolicy(dataRoot: string = DEFAULT_DATA_ROOT): MaturityPolicy {
  const path = join(dataRoot, MATURITY_PATH);
  if (!existsSync(path)) return { version: 1, entries: [] };
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as MaturityPolicy;
  } catch {
    process.stderr.write('[safety] unparseable capability-maturity.json — treating as no maturity evidence\n');
    return { version: 1, entries: [] };
  }
}

export function getCapabilitySafety(
  product: string,
  capabilityId: string,
  dataRoot: string = DEFAULT_DATA_ROOT,
): CapabilitySafetySummary {
  const safety = loadSafetyPolicy(dataRoot);
  const maturity = loadMaturityPolicy(dataRoot);
  const normalizedProduct = normalizeSafetyProduct(product);
  const safetyEntry = safety.entries.find((entry) => sameCapability(entry, normalizedProduct, capabilityId));
  const maturityEntry = maturity.entries.find((entry) => sameCapability(entry, normalizedProduct, capabilityId));
  const safetyClass = safetyEntry?.safetyClass ?? safety.defaultSafetyClass;
  const level = maturityEntry?.maturity ?? 'planned';
  return {
    product: normalizedProduct,
    capabilityId,
    safetyClass,
    maturity: level,
    autoAllowed: safetyClass === 'auto_allowed',
    fieldVerifiedAutoAllowed: safetyClass === 'auto_allowed' && level === 'field_verified',
    reason: safetyEntry?.reason ?? 'No explicit safety entry; default deny/human-only applies.',
    evidence: maturityEntry?.evidence,
  };
}

export function listCapabilitySafety(dataRoot: string = DEFAULT_DATA_ROOT): CapabilitySafetySummary[] {
  const safety = loadSafetyPolicy(dataRoot);
  const maturity = loadMaturityPolicy(dataRoot);
  const keys = new Map<string, { product: string; capabilityId: string }>();
  for (const entry of [...safety.entries, ...maturity.entries]) {
    const product = normalizeSafetyProduct(entry.product);
    keys.set(`${product}:${entry.capabilityId}`, { product, capabilityId: entry.capabilityId });
  }
  return [...keys.values()]
    .sort((a, b) => `${a.product}:${a.capabilityId}`.localeCompare(`${b.product}:${b.capabilityId}`))
    .map((key) => getCapabilitySafety(key.product, key.capabilityId, dataRoot));
}

function sameCapability(entry: { product: string; capabilityId: string }, product: string, capabilityId: string): boolean {
  return normalizeSafetyProduct(entry.product) === product && entry.capabilityId === capabilityId;
}

function normalizeSafetyProduct(input: string): string {
  const s = input.trim().toLowerCase();
  if (/\b(epp|endpoint|endpoint secure|edr|asec)\b/.test(s)) return 'ENDPOINT_SECURE';
  if (/\b(hci\/scp|hci scp|scp|sangfor cloud platform)\b/.test(s)) return 'HCI_SCP';
  if (/\b(iag|swg|internet access|secure web)\b/.test(s)) return 'IAG';
  if (/\b(cyber command|cc|ndr)\b/.test(s)) return 'NDR';
  return input.trim().toUpperCase();
}
