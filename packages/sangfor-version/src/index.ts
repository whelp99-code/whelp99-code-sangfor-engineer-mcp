/**
 * @sangfor/version — version compatibility + upgrade advisory, grounded in the
 * collected "Version Requirements" tables. Conservative: unknown devices return null
 * (no fabricated compatibility claim).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { lstatSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { URL } from 'node:url';

export interface VersionRequirement {
  device: string;
  minVersion: string;
  recommendedVersion: string;
  source: string;
  sourceUrl?: string;
}

export type FirmwareTruthStatus = 'candidate' | 'conflict' | 'verified' | 'superseded';
export type FirmwareTruthVendor = 'SANGFOR' | 'FORTINET' | 'CISCO';
export type SpecApplicability = 'unreviewed' | 'verified';

export interface FirmwareTruthRecord {
  id: string;
  vendor: FirmwareTruthVendor;
  adapterProduct: string;
  productVariant: string | null;
  versionRaw: string;
  versionFamily: string;
  revision: string | null;
  buildId: string | null;
  hotfix: string | null;
  uiFingerprint: string | null;
  apiFingerprint: string | null;
  status: FirmwareTruthStatus;
  observedAt: string | null;
  evidenceFile: string | null;
  specVersion: string | null;
  specApplicability: SpecApplicability;
  source: string;
}

export type FirmwareIdentity = Pick<
  FirmwareTruthRecord,
  | 'id' | 'vendor' | 'adapterProduct' | 'versionRaw' | 'versionFamily'
  | 'productVariant' | 'revision' | 'buildId' | 'hotfix'
  | 'uiFingerprint' | 'apiFingerprint' | 'specVersion' | 'specApplicability'
>;

export class FirmwareTruthError extends Error {
  readonly code: 'INVALID_FIRMWARE_TRUTH' | 'INVALID_VERSION_TRUTH_TRANSITION';

  constructor(code: FirmwareTruthError['code'], message: string) {
    super(`${code}: ${message}`);
    this.name = 'FirmwareTruthError';
    this.code = code;
  }
}

export interface VersionCheck {
  device: string;
  currentVersion: string;
  minVersion: string;
  recommendedVersion: string;
  meetsMin: boolean;
  atRecommended: boolean;
  source: string;
  sourceUrl?: string;
  advice: string;
}

const DATA_ROOT = process.env.SANGFOR_VERSION_ROOT ?? 'data/version';

/** Compare two version strings numerically (segment by segment, digits only). -1|0|1. */
export function compareVersions(a: string, b: string): number {
  // Extract every numeric group (incl. an R-build number) as an ordered segment:
  // '6.0.4R4' → [6,0,4,4], '3.0.92' → [3,0,92], '13.0.120' → [13,0,120].
  const seg = (v: string) => (String(v).match(/\d+/g) ?? []).map(Number);
  const sa = seg(a);
  const sb = seg(b);
  const len = Math.max(sa.length, sb.length);
  for (let i = 0; i < len; i++) {
    const x = sa[i] ?? 0;
    const y = sb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

export function loadVersionRequirements(root: string = DATA_ROOT): VersionRequirement[] {
  if (!existsSync(root)) return [];
  const out: VersionRequirement[] = [];
  for (const f of readdirSync(root).filter((x) => x.endsWith('.json') && !x.startsWith('.'))) {
    const parsed = JSON.parse(readFileSync(join(root, f), 'utf8'));
    const arr = Array.isArray(parsed) ? parsed : parsed.requirements;
    if (Array.isArray(arr)) out.push(...(arr as VersionRequirement[]));
  }
  return out;
}

const FIRMWARE_TRUTH_KEYS = [
  'id', 'vendor', 'adapterProduct', 'productVariant', 'versionRaw', 'versionFamily',
  'revision', 'buildId', 'hotfix', 'uiFingerprint', 'apiFingerprint', 'status',
  'observedAt', 'evidenceFile', 'specVersion', 'specApplicability', 'source',
] as const;

const FIRMWARE_STATUS_VALUES: readonly FirmwareTruthStatus[] = ['candidate', 'conflict', 'verified', 'superseded'];
const FIRMWARE_VENDOR_VALUES: readonly FirmwareTruthVendor[] = ['SANGFOR', 'FORTINET', 'CISCO'];
const SPEC_APPLICABILITY_VALUES: readonly SpecApplicability[] = ['unreviewed', 'verified'];
const SHA256_HEX = /^[a-f0-9]{64}$/;
const ISO_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function invalidTruth(message: string): never {
  throw new FirmwareTruthError('INVALID_FIRMWARE_TRUTH', message);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') invalidTruth(`${key} must be a non-empty string.`);
  return value;
}

function nullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') invalidTruth(`${key} must be null or a non-empty string.`);
  return value;
}

function nullableHash(record: Record<string, unknown>, key: string): string | null {
  const value = nullableString(record, key);
  if (value !== null && !SHA256_HEX.test(value)) invalidTruth(`${key} must be a lowercase SHA-256 hex digest.`);
  return value;
}

function nullableTimestamp(record: Record<string, unknown>, key: string): string | null {
  const value = nullableString(record, key);
  if (value === null) return null;
  const date = new Date(value);
  const canonical = value.includes('.') ? value : value.replace('Z', '.000Z');
  if (!ISO_UTC_TIMESTAMP.test(value) || !Number.isFinite(date.getTime()) || date.toISOString() !== canonical) {
    invalidTruth(`${key} must be an ISO-8601 UTC timestamp.`);
  }
  return value;
}

function validateEvidenceReference(value: string | null, required: boolean): string | null {
  if (value === null) {
    if (required) invalidTruth('verified truth requires a relative evidenceFile.');
    return null;
  }
  if (value !== value.trim() || value.length === 0 || value.includes('\0')
    || isAbsolute(value) || win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    invalidTruth('evidenceFile must be a non-empty relative path.');
  }
  const segments = value.split(/[\\/]+/);
  if (segments.some((segment) => segment === '..' || segment === '')) {
    invalidTruth('evidenceFile may not contain traversal or empty path segments.');
  }
  return value;
}

export function parseFirmwareTruthRecord(input: unknown): FirmwareTruthRecord {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalidTruth('record must be an object.');
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== FIRMWARE_TRUTH_KEYS.length || keys.some((key) => !FIRMWARE_TRUTH_KEYS.includes(key as typeof FIRMWARE_TRUTH_KEYS[number]))) {
    invalidTruth('record contains unknown or missing keys.');
  }
  const id = requiredString(record, 'id');
  const vendor = requiredString(record, 'vendor') as FirmwareTruthVendor;
  if (!FIRMWARE_VENDOR_VALUES.includes(vendor)) invalidTruth('vendor is invalid.');
  const adapterProduct = requiredString(record, 'adapterProduct');
  const productVariant = nullableString(record, 'productVariant');
  const versionRaw = requiredString(record, 'versionRaw');
  const versionFamily = requiredString(record, 'versionFamily');
  const revision = nullableString(record, 'revision');
  const buildId = nullableString(record, 'buildId');
  const hotfix = nullableString(record, 'hotfix');
  const uiFingerprint = nullableHash(record, 'uiFingerprint');
  const apiFingerprint = nullableHash(record, 'apiFingerprint');
  const status = requiredString(record, 'status') as FirmwareTruthStatus;
  if (!FIRMWARE_STATUS_VALUES.includes(status)) invalidTruth('status is invalid.');
  const observedAt = nullableTimestamp(record, 'observedAt');
  const evidenceFile = validateEvidenceReference(nullableString(record, 'evidenceFile'), status === 'verified');
  const specVersion = nullableString(record, 'specVersion');
  const specApplicability = requiredString(record, 'specApplicability') as SpecApplicability;
  if (!SPEC_APPLICABILITY_VALUES.includes(specApplicability)) invalidTruth('specApplicability is invalid.');
  if (specApplicability === 'verified' && specVersion === null) invalidTruth('verified spec applicability requires specVersion.');
  if (status === 'verified' && observedAt === null) invalidTruth('verified truth requires observedAt.');
  const source = requiredString(record, 'source');
  return {
    id,
    vendor,
    adapterProduct,
    productVariant,
    versionRaw,
    versionFamily,
    revision,
    buildId,
    hotfix,
    uiFingerprint,
    apiFingerprint,
    status,
    observedAt,
    evidenceFile,
    specVersion,
    specApplicability,
    source,
  };
}

export function loadFirmwareTruthRecords(root: string = DATA_ROOT): FirmwareTruthRecord[] {
  if (!existsSync(root)) return [];
  const out: FirmwareTruthRecord[] = [];
  for (const f of readdirSync(root).filter((x) => x.endsWith('.json') && !x.startsWith('.'))) {
    const parsed: unknown = JSON.parse(readFileSync(join(root, f), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const truth = (parsed as { firmwareTruth?: unknown }).firmwareTruth;
    if (truth === undefined) continue;
    if (!Array.isArray(truth)) invalidTruth(`firmwareTruth in ${f} must be an array.`);
    out.push(...truth.map((record) => parseFirmwareTruthRecord(record)));
  }
  return out;
}

function identityFields(record: FirmwareIdentity): readonly unknown[] {
  return [
    record.vendor,
    record.adapterProduct,
    record.productVariant,
    record.versionRaw,
    record.versionFamily,
    record.revision,
    record.buildId,
    record.hotfix,
    record.uiFingerprint,
    record.apiFingerprint,
    record.specVersion,
    record.specApplicability,
  ];
}

/** Exact truth comparison. This intentionally does not call compareVersions. */
export function sameFirmwareIdentity(a: FirmwareIdentity, b: FirmwareIdentity): boolean {
  return identityFields(a).every((value, index) => value === identityFields(b)[index]);
}

export function toFirmwareIdentity(record: FirmwareTruthRecord): FirmwareIdentity {
  const parsed = parseFirmwareTruthRecord(record);
  if (parsed.status !== 'verified') {
    throw new FirmwareTruthError('INVALID_FIRMWARE_TRUTH', 'Only verified records can produce FirmwareIdentity.');
  }
  return {
    id: parsed.id,
    vendor: parsed.vendor,
    adapterProduct: parsed.adapterProduct,
    versionRaw: parsed.versionRaw,
    versionFamily: parsed.versionFamily,
    productVariant: parsed.productVariant,
    revision: parsed.revision,
    buildId: parsed.buildId,
    hotfix: parsed.hotfix,
    uiFingerprint: parsed.uiFingerprint,
    apiFingerprint: parsed.apiFingerprint,
    specVersion: parsed.specVersion,
    specApplicability: parsed.specApplicability,
  };
}

export interface EvidenceRootOptions {
  evidenceRoot: string;
}

function evidenceIsConfinedRegularFile(evidenceFile: string | null, evidenceRoot: string | undefined): boolean {
  if (!evidenceFile || !evidenceRoot || evidenceFile.includes('\0') || isAbsolute(evidenceFile)
    || win32.isAbsolute(evidenceFile) || /^[A-Za-z]:/.test(evidenceFile)) return false;
  if (evidenceFile.split(/[\\/]+/).some((segment) => segment === '..' || segment === '')) return false;
  let rootReal: string;
  let targetAbs: string;
  try {
    rootReal = realpathSync(resolve(evidenceRoot));
    if (!lstatSync(rootReal).isDirectory()) return false;
    targetAbs = resolve(rootReal, evidenceFile);
    const lexicalRelative = relative(rootReal, targetAbs);
    if (!lexicalRelative || lexicalRelative.startsWith(`..${sep}`) || isAbsolute(lexicalRelative)) return false;
    const targetStat = lstatSync(targetAbs);
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) return false;
    const targetReal = realpathSync(targetAbs);
    const realRelative = relative(rootReal, targetReal);
    if (!realRelative || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) return false;
    return lstatSync(targetReal).isFile();
  } catch {
    return false;
  }
}

export function isEvidenceFileConfined(evidenceFile: string | null, options?: EvidenceRootOptions): boolean {
  return evidenceIsConfinedRegularFile(evidenceFile, options?.evidenceRoot);
}

export function isFirmwareTruthEligible(record: FirmwareTruthRecord, options?: EvidenceRootOptions): boolean {
  try {
    const parsed = parseFirmwareTruthRecord(record);
    return parsed.status === 'verified'
      && parsed.specApplicability === 'verified'
      && parsed.specVersion !== null
      && options !== undefined
      && evidenceIsConfinedRegularFile(parsed.evidenceFile, options.evidenceRoot);
  } catch {
    return false;
  }
}

export const isEligibleFirmwareTruth = isFirmwareTruthEligible;

const FIRMWARE_STATUS_TRANSITIONS: Record<FirmwareTruthStatus, readonly FirmwareTruthStatus[]> = {
  candidate: ['candidate', 'conflict', 'verified', 'superseded'],
  conflict: ['conflict', 'verified', 'superseded'],
  verified: ['verified', 'superseded'],
  superseded: ['superseded'],
};

export function transitionFirmwareTruthStatus(
  record: FirmwareTruthRecord,
  nextStatus: FirmwareTruthStatus,
  patch: Partial<FirmwareTruthRecord> = {},
): FirmwareTruthRecord {
  const current = parseFirmwareTruthRecord(record);
  if (patch.id !== undefined && patch.id !== current.id) {
    throw new FirmwareTruthError('INVALID_VERSION_TRUTH_TRANSITION', 'Firmware truth id is immutable.');
  }
  if (!FIRMWARE_STATUS_TRANSITIONS[current.status].includes(nextStatus)) {
    throw new FirmwareTruthError('INVALID_VERSION_TRUTH_TRANSITION', `${current.status} cannot transition to ${nextStatus}.`);
  }
  return parseFirmwareTruthRecord({ ...current, ...patch, id: current.id, status: nextStatus });
}

const MAX_FINGERPRINT_VALUE_LENGTH = 256;
const MAX_FINGERPRINT_ROUTE_ITEMS = 64;
const MAX_FINGERPRINT_ROUTE_TOTAL_LENGTH = 4096;
const MAX_FINGERPRINT_ROUTE_INPUT_LENGTH = 4096;
const SAFE_FINGERPRINT_ROUTE_SEGMENTS = new Set([
  'dashboard', 'system', 'index', 'overview', 'policy', 'antimalware', 'scan', 'appcontrol',
  'devicecontrol', 'event', 'deployment', 'activityaudit', 'dlppolicy', 'dlpevent',
  'onlineactivities', 'accesspolicy', 'authentication', 'endpointcompliance', 'logs',
  'internetaccess', 'detection', 'threats', 'response',
]);
const SAFE_FINGERPRINT_ROUTE_PARAMETERS = new Set([
  'id', 'productid', 'policyid', 'ruleid', 'eventid', 'taskid', 'reportid', 'customerid',
  'userid', 'deviceid', 'year', 'month', 'day', 'version', 'variant',
]);
const FINGERPRINT_ROUTE_ROOT = '__root__';

function compareCodePoints(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  const length = Math.max(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftCode = leftPoints[index]?.codePointAt(0) ?? -1;
    const rightCode = rightPoints[index]?.codePointAt(0) ?? -1;
    if (leftCode < rightCode) return -1;
    if (leftCode > rightCode) return 1;
  }
  return 0;
}

function stableFingerprintJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableFingerprintJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort(compareCodePoints).map((key) => `${JSON.stringify(key)}:${stableFingerprintJson(record[key])}`).join(',')}}`;
}

function boundedFingerprintString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') invalidTruth(`${field} must be a bounded string or null.`);
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (normalized.length === 0 || [...normalized].length > MAX_FINGERPRINT_VALUE_LENGTH) {
    invalidTruth(`${field} is empty or exceeds the fingerprint size limit.`);
  }
  return normalized;
}

function fingerprintDigest(domain: string, value: string): string {
  return createHash('sha256').update(`${domain}\0${value}`, 'utf8').digest('hex');
}

function canonicalFramework(value: unknown): { name: string | null; version: string | null } | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) invalidTruth('framework must be an object or null.');
  const framework = value as Record<string, unknown>;
  const name = boundedFingerprintString(framework.name, 'framework.name');
  const version = boundedFingerprintString(framework.version, 'framework.version');
  if (name === null && version === null) invalidTruth('framework has no usable name or version.');
  return { name, version };
}

function routeInputString(value: unknown, field: string): string {
  if (typeof value !== 'string') invalidTruth(`${field} must be a bounded route string.`);
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (normalized.length === 0 || [...normalized].length > MAX_FINGERPRINT_ROUTE_INPUT_LENGTH
    || [...normalized].some((character) => /\p{Cc}/u.test(character))) {
    invalidTruth(`${field} is empty, contains control characters, or exceeds the route size limit.`);
  }
  return normalized;
}

function hashRouterPath(value: string): string | null {
  let hashPath = value.startsWith('#') ? value.slice(1) : value;
  if (hashPath.startsWith('!')) hashPath = hashPath.slice(1);
  if (!hashPath.startsWith('/')) return null;
  const queryOrFragment = hashPath.search(/[?#]/u);
  return queryOrFragment === -1 ? hashPath : hashPath.slice(0, queryOrFragment);
}

function canonicalRouteSegments(path: string, field: string): string[] {
  if (path.startsWith('//')) invalidTruth(`${field} contains an invalid hash route path.`);
  if (path === '/') return [FINGERPRINT_ROUTE_ROOT];
  if (path.startsWith('/')) path = path.slice(1);
  if (path.endsWith('/')) path = path.slice(0, -1);
  if (path.length === 0 || [...path].length > MAX_FINGERPRINT_VALUE_LENGTH || path.includes('//')) {
    invalidTruth(`${field} has an empty, oversized, or malformed route path.`);
  }
  const rawSegments = path.split('/');
  const templateSegment = /^(?::([A-Za-z][A-Za-z\d._~-]*)|\{([A-Za-z][A-Za-z\d._~-]*)\})$/u;
  const staticSegment = /^[A-Za-z][A-Za-z\d._~-]*$/u;
  const canonicalSegments = rawSegments.map((rawSegment) => {
    const segment = rawSegment.normalize('NFKC');
    const template = templateSegment.exec(segment);
    if (template) {
      const parameter = (template[1] ?? template[2]!).normalize('NFKC').toLowerCase();
      if (!SAFE_FINGERPRINT_ROUTE_PARAMETERS.has(parameter)) {
        invalidTruth(`${field} contains a route parameter outside the approved structural allowlist.`);
      }
      return `:${parameter}`;
    }
    if (!staticSegment.test(segment)) {
      invalidTruth(`${field} contains a route segment outside the approved static route grammar.`);
    }
    const canonical = segment.toLowerCase();
    if (!SAFE_FINGERPRINT_ROUTE_SEGMENTS.has(canonical)) {
      invalidTruth(`${field} contains a route segment outside the approved static route allowlist.`);
    }
    return canonical;
  });
  return canonicalSegments;
}

function canonicalRoutePath(value: unknown, field: string): string {
  const route = routeInputString(value, field);
  let path = route;
  if (/^[A-Za-z][A-Za-z\d+.-]*:\/\//u.test(route) || route.startsWith('//')) {
    let parsed: URL;
    try {
      parsed = new URL(route.startsWith('//') ? `https:${route}` : route);
    } catch {
      invalidTruth(`${field} is not a valid absolute URL.`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      invalidTruth(`${field} must use http or https.`);
    }
    if (parsed.username || parsed.password) invalidTruth(`${field} must not contain URL userinfo.`);
    path = hashRouterPath(parsed.hash) ?? parsed.pathname;
  } else if (route.includes('://')) {
    invalidTruth(`${field} is not a valid absolute URL.`);
  } else {
    const hashIndex = route.indexOf('#');
    const hashPath = hashIndex === -1 ? null : hashRouterPath(route.slice(hashIndex));
    if (hashPath !== null) {
      path = hashPath;
    } else {
      const queryOrHash = route.search(/[?#]/u);
      path = queryOrHash === -1 ? route : route.slice(0, queryOrHash);
    }
  }

  path = path.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  return canonicalRouteSegments(path, field).join('/');
}

function canonicalRouteSignature(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) invalidTruth('routeSignature must be an array of bounded strings or null.');
  if (value.length > MAX_FINGERPRINT_ROUTE_ITEMS) invalidTruth('routeSignature exceeds the item limit.');
  let totalLength = 0;
  const routes = value.map((route, index) => {
    const normalized = canonicalRoutePath(route, `routeSignature[${index}]`);
    totalLength += [...normalized].length;
    if (totalLength > MAX_FINGERPRINT_ROUTE_TOTAL_LENGTH) invalidTruth('routeSignature exceeds the total size limit.');
    return normalized;
  });
  const uniqueRoutes = [...new Set(routes)];
  return uniqueRoutes.length === 0 ? null : uniqueRoutes.sort(compareCodePoints);
}

/** Retain only bounded allowlisted descriptors and represent opaque values by domain-separated digests. */
export function canonicalizeFingerprintDescriptors(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    invalidTruth('fingerprint descriptors must be a non-null object.');
  }
  const source = input as Record<string, unknown>;
  const apiSchemaSignature = boundedFingerprintString(source.apiSchemaSignature, 'apiSchemaSignature');
  const assetManifestId = boundedFingerprintString(source.assetManifestId, 'assetManifestId');
  const buildId = boundedFingerprintString(source.buildId, 'buildId');
  const rawBuildId = boundedFingerprintString(source.rawBuildId, 'rawBuildId');
  if (buildId !== null && rawBuildId !== null && buildId !== rawBuildId) {
    invalidTruth('buildId and rawBuildId disagree.');
  }
  const framework = canonicalFramework(source.framework);
  const frameworkVersion = boundedFingerprintString(source.frameworkVersion, 'frameworkVersion');
  if (framework !== null && framework.version !== null && frameworkVersion !== null && framework.version !== frameworkVersion) {
    invalidTruth('framework.version and frameworkVersion disagree.');
  }
  const effectiveFrameworkVersion = framework?.version ?? frameworkVersion;
  const routeSignature = canonicalRouteSignature(source.routeSignature);
  const effectiveBuildId = buildId ?? rawBuildId;
  const descriptor = {
    apiSchemaSignature: apiSchemaSignature === null ? null : fingerprintDigest('apiSchemaSignature', apiSchemaSignature),
    assetManifestId: assetManifestId === null ? null : fingerprintDigest('assetManifestId', assetManifestId),
    buildId: effectiveBuildId === null ? null : fingerprintDigest('buildId', effectiveBuildId),
    framework: framework === null && effectiveFrameworkVersion === null ? null : {
      name: framework?.name === null || framework?.name === undefined ? null : fingerprintDigest('framework.name', framework.name),
      version: effectiveFrameworkVersion === null ? null : fingerprintDigest('framework.version', effectiveFrameworkVersion),
    },
    routeSignature: routeSignature === null ? null : fingerprintDigest('routeSignature', stableFingerprintJson(routeSignature)),
  };
  const usableFieldCount = [
    descriptor.apiSchemaSignature,
    descriptor.assetManifestId,
    descriptor.buildId,
    descriptor.framework?.name,
    descriptor.framework?.version,
    descriptor.routeSignature,
  ].filter((value) => value !== null && value !== undefined).length;
  if (usableFieldCount === 0) invalidTruth('fingerprint descriptors contain no usable safe fields.');
  return stableFingerprintJson(descriptor);
}

export function fingerprintFromDescriptors(input: unknown): string {
  return createHash('sha256').update(canonicalizeFingerprintDescriptors(input)).digest('hex');
}

export function checkVersionRequirement(device: string, currentVersion: string, root: string = DATA_ROOT): VersionCheck | null {
  if (typeof device !== 'string' || typeof currentVersion !== 'string') return null;
  const req = loadVersionRequirements(root).find((r) => r.device.trim().toLowerCase() === device.trim().toLowerCase());
  if (!req) return null;
  const meetsMin = compareVersions(currentVersion, req.minVersion) >= 0;
  const atRecommended = compareVersions(currentVersion, req.recommendedVersion) >= 0;
  const advice = !meetsMin
    ? `최소 지원 버전 미만(${currentVersion} < ${req.minVersion}) — 업그레이드 필요(비호환 위험)`
    : atRecommended
      ? `권장 버전 이상(${req.recommendedVersion}) — 양호`
      : `최소는 충족하나 권장 버전(${req.recommendedVersion}) 미만 — 업그레이드 권장`;
  return {
    device: req.device, currentVersion, minVersion: req.minVersion, recommendedVersion: req.recommendedVersion,
    meetsMin, atRecommended, source: req.source, sourceUrl: req.sourceUrl, advice,
  };
}
