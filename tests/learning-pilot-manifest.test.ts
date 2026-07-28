import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

type Dependency = 'vpn' | 'device' | 'cdp' | 'approval_secret' | 'postgres';
type PilotStatus = 'PASS' | 'NOT_RUN' | 'BLOCKED';
type Availability = 'available' | 'unavailable';

interface PilotEvidence {
  path: string;
  sha256: string;
  capturedAt: string;
  kind: 'capture_bundle' | 'observation' | 'official_citation' | 'human_approval';
}

interface PilotRecord {
  pilotId: 'cc-3.0.98' | 'iag-13.0.120' | 'fortios-8.0';
  product: 'CC' | 'IAG' | 'FORTIOS';
  firmwareVersion: string;
  status: PilotStatus;
  requiredDependencies: Dependency[];
  dependencySnapshot: Partial<Record<Dependency, Availability>>;
  reasonCodes: string[];
  evidence: PilotEvidence[];
}

interface PilotManifest {
  schemaVersion: 1;
  generatedAt: string;
  pilots: PilotRecord[];
}

const DEPENDENCIES: readonly Dependency[] = ['vpn', 'device', 'cdp', 'approval_secret', 'postgres'];
const EXPECTED_PILOTS = {
  'cc-3.0.98': { product: 'CC', firmwareVersion: '3.0.98', dependencies: ['vpn', 'device', 'cdp', 'approval_secret'] },
  'iag-13.0.120': { product: 'IAG', firmwareVersion: '13.0.120', dependencies: ['vpn', 'device', 'cdp', 'approval_secret'] },
  'fortios-8.0': { product: 'FORTIOS', firmwareVersion: '8.0', dependencies: ['device', 'approval_secret', 'postgres'] },
} as const;

function probeExternalDependencies(env: Record<string, string | undefined>): Record<Dependency, Availability> {
  return {
    vpn: env.SANGFOR_PILOT_VPN_READY === '1' ? 'available' : 'unavailable',
    device: env.SANGFOR_PILOT_DEVICE_READY === '1' ? 'available' : 'unavailable',
    cdp: env.SANGFOR_PILOT_CDP_READY === '1' ? 'available' : 'unavailable',
    approval_secret: env.SANGFOR_LEARNING_APPROVAL_SECRET ? 'available' : 'unavailable',
    postgres: /^(?:postgres|postgresql):\/\//u.test(env.DATABASE_URL ?? '') ? 'available' : 'unavailable',
  };
}

function validatePilotManifest(manifest: unknown, evidenceRoot: string, probes: Record<Dependency, Availability>): asserts manifest is PilotManifest {
  if (!isRecord(manifest) || manifest.schemaVersion !== 1 || !isIsoDate(manifest.generatedAt) || !Array.isArray(manifest.pilots)
    || manifest.pilots.length !== 3) {
    throw new Error('INVALID_PILOT_MANIFEST');
  }
  const seen = new Set<string>();
  for (const pilot of manifest.pilots) validatePilot(pilot, evidenceRoot, probes, seen);
  if (seen.size !== 3 || Object.keys(EXPECTED_PILOTS).some((pilotId) => !seen.has(pilotId))) {
    throw new Error('INVALID_PILOT_MANIFEST');
  }
}

function validatePilot(value: unknown, evidenceRoot: string, probes: Record<Dependency, Availability>, seen: Set<string>): void {
  if (!isRecord(value) || !isPilotId(value.pilotId) || seen.has(value.pilotId) || !isPilotStatus(value.status)
    || !Array.isArray(value.requiredDependencies) || !isRecord(value.dependencySnapshot)
    || !isStringArray(value.reasonCodes) || !Array.isArray(value.evidence)) {
    throw new Error('INVALID_PILOT_MANIFEST');
  }
  seen.add(value.pilotId);
  const expected = EXPECTED_PILOTS[value.pilotId];
  if (!value.requiredDependencies.every(isDependency)) throw new Error('INVALID_PILOT_MANIFEST');
  const requiredDependencies: Dependency[] = value.requiredDependencies;
  if (value.product !== expected.product || value.firmwareVersion !== expected.firmwareVersion
    || !sameMembers(requiredDependencies, expected.dependencies)) throw new Error('INVALID_PILOT_MANIFEST');

  for (const dependency of requiredDependencies) {
    if (value.dependencySnapshot[dependency] !== probes[dependency]) {
      throw new Error('PILOT_DEPENDENCY_PROBE_MISMATCH');
    }
  }
  if (!value.reasonCodes.every((code) => /^[A-Z][A-Z0-9_]{2,80}$/u.test(code)) || new Set(value.reasonCodes).size !== value.reasonCodes.length) {
    throw new Error('INVALID_PILOT_MANIFEST');
  }

  if (value.status === 'PASS') {
    if (value.reasonCodes.length !== 0 || requiredDependencies.some((dependency) => probes[dependency] !== 'available')
      || value.evidence.length === 0) throw new Error('PILOT_FALSE_PASS');
    value.evidence.forEach((evidence) => validateEvidence(evidence, evidenceRoot));
    return;
  }
  if (value.status === 'NOT_RUN') {
    if (value.evidence.length !== 0 || !value.reasonCodes.includes('OPERATOR_NOT_STARTED')) throw new Error('INVALID_PILOT_MANIFEST');
    return;
  }
  if (value.evidence.length !== 0 || value.reasonCodes.length === 0
    || !requiredDependencies.some((dependency) => probes[dependency] === 'unavailable')
      && !value.reasonCodes.some((code) => /^U_\d\d_/u.test(code))) {
    throw new Error('INVALID_PILOT_MANIFEST');
  }
}

function validateEvidence(value: unknown, evidenceRoot: string): void {
  if (!isRecord(value) || !isSafeRelativePath(value.path) || !isDigest(value.sha256) || !isIsoDate(value.capturedAt)
    || !['capture_bundle', 'observation', 'official_citation', 'human_approval'].includes(value.kind as string)) {
    throw new Error('INVALID_PILOT_EVIDENCE');
  }
  const root = resolve(evidenceRoot);
  const candidate = resolve(root, value.path);
  const suffix = relative(root, candidate);
  if (suffix === '' || suffix.startsWith('..') || isAbsolute(suffix) || !existsSync(candidate)) throw new Error('PILOT_EVIDENCE_OUTSIDE_ROOT');
  const metadata = lstatSync(candidate);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0) throw new Error('INVALID_PILOT_EVIDENCE');
  const digest = createHash('sha256').update(readFileSync(candidate)).digest('hex');
  if (digest !== value.sha256) throw new Error('PILOT_EVIDENCE_DIGEST_MISMATCH');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isPilotId(value: unknown): value is PilotRecord['pilotId'] { return typeof value === 'string' && value in EXPECTED_PILOTS; }
function isPilotStatus(value: unknown): value is PilotStatus { return value === 'PASS' || value === 'NOT_RUN' || value === 'BLOCKED'; }
function isDependency(value: unknown): value is Dependency { return typeof value === 'string' && DEPENDENCIES.includes(value as Dependency); }
function isStringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every((entry) => typeof entry === 'string'); }
function isDigest(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); }
function isIsoDate(value: unknown): value is string { return typeof value === 'string' && !Number.isNaN(Date.parse(value)); }
function isSafeRelativePath(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$/u.test(value) && !value.split('/').includes('..');
}
function sameMembers(actual: unknown[], expected: readonly string[]): boolean {
  return actual.length === expected.length && new Set(actual).size === actual.length && actual.every((entry) => expected.includes(entry as never));
}

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../docs/acceptance/learning-strategy-observer/fixtures/${name}`, import.meta.url), 'utf8'));
}

describe('PR-012 REQ-25 pilot manifest acceptance', () => {
  let evidenceRoot: string;
  const allAvailable = probeExternalDependencies({
    SANGFOR_PILOT_VPN_READY: '1', SANGFOR_PILOT_DEVICE_READY: '1', SANGFOR_PILOT_CDP_READY: '1',
    SANGFOR_LEARNING_APPROVAL_SECRET: 'injected-only-for-test', DATABASE_URL: 'postgresql://localhost/test',
  });
  const allUnavailable = probeExternalDependencies({});

  beforeEach(() => { evidenceRoot = mkdtempSync(join(tmpdir(), 'pilot-manifest-evidence-')); });
  afterEach(() => rmSync(evidenceRoot, { recursive: true, force: true }));

  it('defines the strict v1 schema and keeps checked-in fixtures honest about external blockers', () => {
    const schema = JSON.parse(readFileSync(new URL('../docs/acceptance/learning-strategy-observer/pilot-manifest.schema.json', import.meta.url), 'utf8'));
    expect(schema).toMatchObject({ $schema: 'https://json-schema.org/draft/2020-12/schema', properties: { schemaVersion: { const: 1 } } });
    validatePilotManifest(readFixture('external-dependencies-blocked.json'), evidenceRoot, allUnavailable);
    validatePilotManifest(readFixture('not-run-before-window.json'), evidenceRoot, allAvailable);
  });

  it('accepts PASS only with every readiness probe and confined, hashed real-file evidence', () => {
    const evidencePath = join(evidenceRoot, 'cc-observation.json');
    writeFileSync(evidencePath, '{"observation":"sanitized"}\n');
    const manifest = passManifest('cc-3.0.98', 'CC', '3.0.98', 'cc-observation.json', evidencePath);
    validatePilotManifest(manifest, evidenceRoot, allAvailable);
  });

  it('rejects false PASS from an unavailable probe, missing evidence, digest drift, or a symlink', () => {
    const evidencePath = join(evidenceRoot, 'cc-observation.json');
    writeFileSync(evidencePath, '{"observation":"sanitized"}\n');
    const manifest = passManifest('cc-3.0.98', 'CC', '3.0.98', 'cc-observation.json', evidencePath);
    expect(() => validatePilotManifest(manifest, evidenceRoot, allUnavailable)).toThrow('PILOT_DEPENDENCY_PROBE_MISMATCH');
    manifest.pilots[0]!.dependencySnapshot = { vpn: 'available', device: 'available', cdp: 'available', approval_secret: 'available' };
    manifest.pilots[0]!.evidence = [];
    expect(() => validatePilotManifest(manifest, evidenceRoot, allAvailable)).toThrow('PILOT_FALSE_PASS');
    manifest.pilots[0]!.evidence = [evidenceFor('cc-observation.json', evidencePath)];
    manifest.pilots[0]!.evidence[0]!.sha256 = '0'.repeat(64);
    expect(() => validatePilotManifest(manifest, evidenceRoot, allAvailable)).toThrow('PILOT_EVIDENCE_DIGEST_MISMATCH');
    manifest.pilots[0]!.evidence = [evidenceFor('link.json', evidencePath)];
    symlinkSync(evidencePath, join(evidenceRoot, 'link.json'));
    expect(() => validatePilotManifest(manifest, evidenceRoot, allAvailable)).toThrow('INVALID_PILOT_EVIDENCE');
  });

  it('rejects empty statuses, unstarted runs with evidence, and blockers without a concrete cause', () => {
    const blocked = readFixture('external-dependencies-blocked.json') as PilotManifest;
    blocked.pilots[0]!.status = 'UNKNOWN' as PilotStatus;
    expect(() => validatePilotManifest(blocked, evidenceRoot, allUnavailable)).toThrow('INVALID_PILOT_MANIFEST');
    const notRun = readFixture('not-run-before-window.json') as PilotManifest;
    notRun.pilots[0]!.evidence = [{
      path: 'missing.json', sha256: 'a'.repeat(64), capturedAt: '2026-07-28T00:00:00.000Z', kind: 'observation',
    }];
    expect(() => validatePilotManifest(notRun, evidenceRoot, allAvailable)).toThrow('INVALID_PILOT_MANIFEST');
    const invalidBlocked = readFixture('external-dependencies-blocked.json') as PilotManifest;
    invalidBlocked.pilots[0]!.reasonCodes = [];
    expect(() => validatePilotManifest(invalidBlocked, evidenceRoot, allUnavailable)).toThrow('INVALID_PILOT_MANIFEST');
  });
});

function evidenceFor(path: string, absolutePath: string): PilotEvidence {
  return {
    path,
    sha256: createHash('sha256').update(readFileSync(absolutePath)).digest('hex'),
    capturedAt: '2026-07-28T00:00:00.000Z',
    kind: 'observation',
  };
}

function passManifest(pilotId: 'cc-3.0.98', product: 'CC', firmwareVersion: string, evidencePath: string, absolutePath: string): PilotManifest {
  const record: PilotRecord = {
    pilotId, product, firmwareVersion, status: 'PASS',
    requiredDependencies: ['vpn', 'device', 'cdp', 'approval_secret'],
    dependencySnapshot: { vpn: 'available', device: 'available', cdp: 'available', approval_secret: 'available' },
    reasonCodes: [], evidence: [evidenceFor(evidencePath, absolutePath)],
  };
  return {
    schemaVersion: 1,
    generatedAt: '2026-07-28T00:00:00.000Z',
    pilots: [
      record,
      { ...record, pilotId: 'iag-13.0.120', product: 'IAG', firmwareVersion: '13.0.120', status: 'NOT_RUN', reasonCodes: ['OPERATOR_NOT_STARTED'], evidence: [] },
      { pilotId: 'fortios-8.0', product: 'FORTIOS', firmwareVersion: '8.0', status: 'NOT_RUN', requiredDependencies: ['device', 'approval_secret', 'postgres'], dependencySnapshot: { device: 'available', approval_secret: 'available', postgres: 'available' }, reasonCodes: ['OPERATOR_NOT_STARTED'], evidence: [] },
    ],
  };
}
