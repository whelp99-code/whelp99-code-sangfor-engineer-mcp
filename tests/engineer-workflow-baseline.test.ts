import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HCI_INVENTORY_COLLECTED_SURFACES,
  collectInventory,
  summarizeHciHealth,
  type HciClient,
  type HttpJsonResult,
} from '@sangfor/hci-client';
import {
  buildSettingGuideDocx,
  generateExcelBasedChangePlan,
  importExcelRequirementList,
  mapRequirementsToProducts,
  type ExcelRequirementRow,
} from '@sangfor/product-adapters';
import { assessPlanGrounding } from '../packages/sangfor-planner/src/grounding-assessment.js';

const FIXTURE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/engineer-workflow');
const REPO_ROOT = resolve(FIXTURE_ROOT, '../../..');
const STATUS_KEYS = ['implemented', 'fixture_verified', 'historical_live', 'current_live', 'unknown'] as const;
const LIVE_ENVIRONMENTS = new Set(['live', 'current_live']);
const SECRET_FINDING_PATTERNS: Array<{ id: string; re: RegExp }> = [
  { id: 'password-assignment', re: /password\s*[:=]\s*\S+/i },
  { id: 'secret-assignment', re: /secret\s*[:=]\s*\S+/i },
  { id: 'token-assignment', re: /(?:api[_-]?key|authorization)\s*[:=]\s*\S+/i },
  { id: 'private-key', re: /BEGIN [A-Z ]*PRIVATE KEY/ },
  { id: 'lab-credential-class', re: /Itac\d{2,}/ },
  { id: 'historical-host-copy', re: /10\.80\.1\.\d+/ },
];

type EvidenceFlags = Record<(typeof STATUS_KEYS)[number], boolean>;
type Capability = EvidenceFlags & { id: string; title: string };
type RequiredField = { id: string; sourceKind: string; collection: string };
type CaseManifest = {
  caseId: string;
  mode: string;
  product: string;
  environmentKind: string;
  synthetic: boolean;
  originalPresent: boolean;
  sourceKind: string;
  requiredFields: RequiredField[];
  expected: Record<string, unknown>;
};

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(join(FIXTURE_ROOT, rel), 'utf8')) as T;
}

function sha256File(relFromRepo: string): string {
  return createHash('sha256').update(readFileSync(join(REPO_ROOT, relFromRepo))).digest('hex');
}

function walkFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) walkFiles(path, acc);
    else acc.push(path);
  }
  return acc;
}

function secretFindings(text: string): string[] {
  return SECRET_FINDING_PATTERNS.filter((pattern) => pattern.re.test(text)).map((pattern) => pattern.id);
}

function provenanceDefects(input: {
  environmentKind: string;
  originalPresent?: boolean;
  sourceKind?: string;
  synthetic?: boolean;
  currentLive?: boolean;
}): string[] {
  const defects: string[] = [];
  if (LIVE_ENVIRONMENTS.has(input.environmentKind)) defects.push('fixture-marked-live');
  if (input.currentLive === true) defects.push('current-live-claimed');
  if (input.originalPresent === false && input.sourceKind === 'observed') defects.push('missing-original-marked-observed');
  if (input.originalPresent === false && input.synthetic !== true && input.environmentKind === 'fixture') {
    defects.push('missing-original-unmarked-synthetic');
  }
  return defects;
}

function findRepoFileBySha256(hex: string): string | undefined {
  for (const root of ['.hermes', 'outputs', 'data', 'tests', 'docs']) {
    const abs = join(REPO_ROOT, root);
    if (!existsSync(abs)) continue;
    const hit = walkFiles(abs).find((path) => (
      path.endsWith('.xlsx')
      && createHash('sha256').update(readFileSync(path)).digest('hex') === hex
    ));
    if (hit) return hit;
  }
  return undefined;
}

function response(json: unknown, status = 200): HttpJsonResult {
  return { json, status, text: JSON.stringify(json) };
}

function inventoryClient(payload: {
  volumes: unknown[];
  servers: unknown[];
  images: unknown[];
}): Pick<HciClient, 'request'> {
  return {
    async request(service) {
      if (service === 'volume') return response({ volumes: payload.volumes });
      if (service === 'compute') return response({ servers: payload.servers });
      if (service === 'image') return response({ images: payload.images });
      throw new Error(`unexpected service ${service}`);
    },
  };
}

describe('engineer workflow E00 baseline', () => {
  const baseline = readJson<{
    environmentKind: string;
    collectionCensus: {
      collectedSurfaces: number;
      collectedVolumeFields: string[];
      requiredExistingCaseFields: number;
      missingRequiredFields: number;
      missingCollectionFields: number;
      notProductWideCoverage: boolean;
    };
    scale: { fixtureReplayBudgetMs: number };
  }>('baseline.json');
  const capabilitiesDoc = readJson<{ statusVocabulary: string[]; capabilities: Capability[] }>('capabilities.json');
  const historical = readJson<{
    environmentKind: string;
    currentLive: boolean;
    records: Array<{
      repoEvidence?: Record<string, string>;
      counts?: { servers?: number; images?: number; volumes?: number; volumeServiceAvailable?: boolean };
    }>;
  }>('historical-evidence.json');
  const existingCase = readJson<CaseManifest>('cases/existing-hci-health.json');
  const newCase = readJson<CaseManifest>('cases/new-hci-build.json');
  const excelCase = readJson<CaseManifest & {
    originalWorkbook: { discoverBySha256: string; prioritizeOnly: boolean };
    expected: {
      totalItems: number;
      consoleItems: number;
      manualItems: number;
      mapped: Record<string, number>;
    };
  }>('cases/historical-excel-26.json');

  it('records every capability status vocabulary without promoting current live', () => {
    expect(capabilitiesDoc.statusVocabulary).toEqual([...STATUS_KEYS]);
    expect(capabilitiesDoc.capabilities.length).toBeGreaterThan(0);
    for (const capability of capabilitiesDoc.capabilities) {
      for (const key of STATUS_KEYS) {
        expect(typeof capability[key], capability.id).toBe('boolean');
      }
      expect(capability.current_live, capability.id).toBe(false);
    }
  });

  it('keeps fixture and historical records from being current live or observed originals', () => {
    expect(provenanceDefects(baseline)).toEqual([]);
    expect(provenanceDefects(historical)).toEqual([]);
    expect(provenanceDefects(existingCase)).toEqual([]);
    expect(provenanceDefects(newCase)).toEqual([]);
    expect(provenanceDefects(excelCase)).toEqual([]);
    expect(existingCase.originalPresent).toBe(false);
    expect(existingCase.synthetic).toBe(true);
    expect(newCase.synthetic).toBe(true);
    expect(excelCase.originalPresent).toBe(true);
    expect(excelCase.environmentKind).toBe('fixture');
  });

  it('rejects missing originals marked as observed and fixture provenance rewritten as live', () => {
    expect(provenanceDefects({
      environmentKind: 'fixture',
      originalPresent: false,
      sourceKind: 'observed',
      synthetic: true,
    })).toContain('missing-original-marked-observed');
    expect(provenanceDefects({
      ...existingCase,
      environmentKind: 'live',
    })).toContain('fixture-marked-live');
    expect(provenanceDefects({
      ...historical,
      currentLive: true,
    })).toContain('current-live-claimed');
  });

  it('keeps secrets and historical host/credential copies out of the baseline fixtures', () => {
    const findings = walkFiles(FIXTURE_ROOT).flatMap((path) => secretFindings(readFileSync(path, 'utf8')));
    expect(findings).toEqual([]);
  });

  it('locks collected HCI surfaces and the numeric gap for the existing case', () => {
    expect(HCI_INVENTORY_COLLECTED_SURFACES).toEqual(['volumes', 'servers', 'images']);
    expect(baseline.collectionCensus.collectedSurfaces).toBe(HCI_INVENTORY_COLLECTED_SURFACES.length);
    expect(baseline.collectionCensus.requiredExistingCaseFields).toBe(existingCase.requiredFields.length);
    expect(baseline.collectionCensus.missingRequiredFields).toBe(
      existingCase.requiredFields.filter((field) => field.collection === 'missing').length,
    );
    expect(baseline.collectionCensus.missingCollectionFields).toBe(
      (existingCase.expected.unknownRequiredFields as string[]).length,
    );
    expect(baseline.collectionCensus.notProductWideCoverage).toBe(true);
    expect(existingCase.expected.unknownRequiredFields).toEqual([
      'host_cpu',
      'host_ram',
      'storage_usable_capacity',
      'network_topology',
      'ha_status',
    ]);
  });

  it('replays the existing HCI health fixture without treating historical live as current', async () => {
    const started = Date.now();
    const inventoryFixture = readJson<{
      collectedAt: string;
      volumes: unknown[];
      servers: unknown[];
      images: unknown[];
    }>('synthetic/existing-hci-inventory.json');
    const inventory = await collectInventory(
      inventoryClient(inventoryFixture),
      { collectedAt: inventoryFixture.collectedAt },
    );
    expect(inventory.readOnly).toBe(true);
    expect(inventory.collection).toMatchObject({
      volumes: { status: 'complete' },
      servers: { status: 'complete' },
      images: { status: 'complete' },
    });
    const health = summarizeHciHealth(inventory);
    expect(health).toMatchObject({
      verdict: existingCase.expected.healthVerdict,
      scope: existingCase.expected.healthScope,
    });
    expect(summarizeHciHealth(inventory, {
      mode: 'current',
      maxAgeSec: 60,
      now: '2026-09-10T00:00:00.000Z',
    }).verdict).toBe('INDETERMINATE');

    const requirements = readJson<{ rows: ExcelRequirementRow[] }>('synthetic/existing-hci-requirements.json');
    const mapped = mapRequirementsToProducts({ rows: requirements.rows });
    expect(mapped.summary.HCI_SCP).toBe(2);
    expect(Date.now() - started).toBeLessThan(baseline.scale.fixtureReplayBudgetMs);
  });

  it('keeps the new-build case provided and refuses to treat proposed specs as observed', () => {
    const requirements = readJson<{
      sourceKind: string;
      providedSpecs: Record<string, unknown>;
      rows: ExcelRequirementRow[];
    }>('synthetic/new-hci-requirements.json');
    expect(requirements.sourceKind).toBe('provided');
    expect(Object.keys(requirements.providedSpecs)).toEqual(newCase.expected.providedSpecFields);
    const mapped = mapRequirementsToProducts({ rows: requirements.rows });
    expect(mapped.summary.HCI_SCP).toBe(1);
    expect(newCase.expected.observedDeviceValues).toBe(0);
    expect(newCase.expected.proposedSettingsAreNotObserved).toBe(true);
    expect(newCase.requiredFields.find((field) => field.id === 'official_bom')?.sourceKind).toBe('unknown');
  });

  it('replays the in-repo 26-item workbook by hash and keeps it off the HCI representative path', async () => {
    const workbook = findRepoFileBySha256(excelCase.originalWorkbook.discoverBySha256);
    expect(workbook, 'original workbook matching locked sha256 must remain in the repo').toBeTruthy();
    const imported = importExcelRequirementList({
      filePath: workbook!,
      prioritizeOnly: excelCase.originalWorkbook.prioritizeOnly,
    });
    const mapped = mapRequirementsToProducts({ rows: imported.rows });
    const plan = generateExcelBasedChangePlan({
      filePath: workbook!,
      prioritizeOnly: excelCase.originalWorkbook.prioritizeOnly,
    });
    expect(plan.workPlan).toHaveLength(excelCase.expected.totalItems);
    expect(plan.workPlan.filter((row) => row.product !== 'external_or_manual')).toHaveLength(excelCase.expected.consoleItems);
    expect(plan.workPlan.filter((row) => row.product === 'external_or_manual')).toHaveLength(excelCase.expected.manualItems);
    expect(mapped.summary).toMatchObject(excelCase.expected.mapped);

    const dir = mkdtempSync(join(tmpdir(), 'e00-guide-'));
    try {
      const docx = await buildSettingGuideDocx({
        filePath: workbook!,
        outputPath: join(dir, 'setting-guide.docx'),
      });
      expect(existsSync(docx.docxPath)).toBe(true);
      expect(docx.totalItems).toBe(26);
      expect(docx.consoleItems).toBe(12);
      expect(docx.manualItems).toBe(14);
      expect(secretFindings(JSON.stringify({ totalItems: docx.totalItems, sections: docx.sections }))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('locks historical evidence hashes without importing them as current PASS', () => {
    expect(sha256File('outputs/diagnosis/HCI_SCP_real_device_smoke_2026-07-02.md')).toBe(
      'aafd2d3c62a589c62f0a5a7ba2a543286d4d80c8cb01c99f083c55519d3fba47',
    );
    expect(sha256File('outputs/sangfor-excel-plan/setting-plan.json')).toBe(
      'c0130612b0ce1eabb080f7ddf4583d3378ee2693a22747f67dae2f155a7e4f4b',
    );
    expect(historical.currentLive).toBe(false);
    expect(historical.records[0]?.counts).toMatchObject({ servers: 28, images: 0, volumes: 0 });
    expect(historical.records[0]?.counts?.volumeServiceAvailable).toBe(false);
    for (const id of ['hci.collect.volumes', 'hci.health.volume_status']) {
      const capability = capabilitiesDoc.capabilities.find((entry) => entry.id === id);
      expect(capability, id).toMatchObject({ historical_live: false, current_live: false });
    }
  });

  it('keeps planner grounding from becoming answer-ready', () => {
    expect(assessPlanGrounding({
      id: 'plan',
      customerName: 'fixture',
      product: 'HCI',
      version: '6.11.3',
      planTitle: 'Draft',
      planSummary: 'Draft only',
      riskLevel: 'low',
      precheck: [],
      steps: [],
      approvalRequiredSteps: [],
      rollbackPlan: [],
      validationPlan: [],
      wikiReferences: [],
      lessonReferences: [],
      manualReferences: [{
        id: 'ref',
        product: 'HCI',
        version: '6.11.3',
        title: 'Manual',
        text: 'Check inventory.',
        sourceType: 'manual',
        trustLevel: 'official',
      }],
    })).toMatchObject({ answerReady: false });
  });
});
