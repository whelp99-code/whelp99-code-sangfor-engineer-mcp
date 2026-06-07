import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  analyzeCustomerRequirements,
  applyApprovedProductChange,
  collectProductConfig,
  discoverProductConsole,
  dryRunProductChange,
  generateExcelBasedChangePlan,
  generateProductChangePlan
  , importExcelRequirementList,
  mapRequirementsToProducts
} from '../packages/sangfor-product-adapters/src/index.js';

describe('Product automation adapters', () => {
  it('uses API-first strategy for HCI/SCP and exposes SCP OpenAPI candidates', () => {
    const discovery = discoverProductConsole({ product: 'SCP', version: '6.11.2' });
    expect(discovery.product).toBe('HCI_SCP');
    expect(discovery.strategy).toBe('api-first');
    expect(JSON.stringify(discovery.capabilities)).toContain('/openstack/compute/v2/servers');

    const snapshot = collectProductConfig({ product: 'HCI/SCP', preferApi: true });
    expect(snapshot.source).toBe('api');
    expect(snapshot.sections.map(section => section.id)).toContain('vm');
  });

  it('generates approval-gated HCI/SCP HA/DRS plan and dry-run request previews', async () => {
    const plan = generateProductChangePlan({
      product: 'HCI_SCP',
      requirements: ['Enable DRS for the HCI resource pool and verify HA status']
    });
    expect(plan.product).toBe('HCI_SCP');
    expect(plan.tasks[0].menuPath.join(' > ')).toContain('HA/DRS');
    expect(plan.tasks[0].approvalRequired).toBe(true);

    const dryRun = await dryRunProductChange({ plan });
    expect(dryRun.mutationPerformed).toBe(false);
    expect(dryRun.stoppedBefore).toContain('Apply');
  });

  it('maps IAG AD/LDAP and access policy requests to WebUI-first tasks', () => {
    const analysis = analyzeCustomerRequirements({
      product: 'IAG',
      requirements: ['Integrate AD/LDAP authentication', 'Create internet URL exception policy']
    });
    expect(analysis.strategy).toBe('webui-first');
    expect(analysis.tasks.map(task => task.capabilityId)).toEqual(['auth_source', 'internet_policy']);
    expect(analysis.tasks.every(task => task.approvalRequired)).toBe(true);
  });

  it('keeps Endpoint Secure agent deployment approval-gated', () => {
    const plan = generateProductChangePlan({
      product: 'Endpoint Secure',
      requirements: ['Deploy agent to pilot group and switch policy to enforce mode']
    });
    expect(plan.product).toBe('ENDPOINT_SECURE');
    expect(plan.tasks[0].capabilityId).toBe('agent_deployment');
    expect(plan.tasks[0].approvalRequired).toBe(true);
  });

  it('treats Cyber Command as NDR hybrid and blocks SOAR response without approval', async () => {
    const plan = generateProductChangePlan({
      product: 'Cyber Command',
      requirements: ['Create SOAR response action to isolate endpoint on critical incident']
    });
    expect(plan.product).toBe('NDR');
    expect(plan.strategy).toBe('hybrid');
    expect(plan.tasks[0].riskLevel).toBe('critical');

    const result = await applyApprovedProductChange({ plan });
    expect(result.ok).toBe(false);
    expect(result.approvalRequired).toBe(true);
  });

  it('imports ITAC Excel rows and normalizes prioritized requirements', () => {
    const filePath = createItacFixtureXlsx();
    const imported = importExcelRequirementList({ filePath });
    expect(imported.sheetName).toBe('Updated Sercurity Checklist (2)');
    expect(imported.headerRow).toBe(4);
    expect(imported.rows.length).toBe(6);
    expect(imported.rows[0].requirement).toContain('Anti-Spam');
    expect(imported.rows[0].priority).toBe('high');
    expect(imported.rows[0].currentGap).toContain('SPAMOUT');
    expect(imported.rows[0].assessmentCriteria).toContain('Use dedicated spam filtering solution');
  });

  it('maps Excel checklist rows to product automation targets and manual handling', () => {
    const imported = importExcelRequirementList({ filePath: createItacFixtureXlsx() });
    const mapped = mapRequirementsToProducts({ rows: imported.rows });
    expect(mapped.rows.find(row => row.no === '1')?.mappedProduct).toBe('external_or_manual');
    expect(mapped.rows.find(row => row.no === '2')?.mappedProduct).toBe('IAG');
    expect(mapped.rows.find(row => row.no === '3')?.mappedProduct).toBe('ENDPOINT_SECURE');
    expect(mapped.rows.find(row => row.no === '4')?.mappedProduct).toBe('NDR');
    expect(mapped.rows.find(row => row.no === '5')?.mappedProduct).toBe('HCI_SCP');
    expect(mapped.rows.find(row => row.no === '6')?.mappedProduct).toBe('external_or_manual');
  });

  it('generates Excel-based dry-run plan and requires session for browser execution', async () => {
    const plan = generateExcelBasedChangePlan({ filePath: createItacFixtureXlsx() });
    expect(plan.source).toBe('excel');
    expect(plan.mutationPerformed).toBe(false);
    expect(plan.stoppedBefore).toContain('Apply');
    expect(plan.workPlan[0]).toMatchObject({
      requestId: 'REQ-1',
      product: 'external_or_manual',
      menu: 'Manual / External evidence',
      status: 'manual_review_required',
      actualApplySupported: false
    });
    const endpointWork = plan.workPlan.find(item => item.product === 'ENDPOINT_SECURE');
    expect(endpointWork?.menu).toBeTruthy();
    expect(endpointWork?.setting).toBeTruthy();
    expect(endpointWork?.description).toBeTruthy();
    expect(plan.manualReviewRows.length).toBeGreaterThan(0);

    const dryRun = await dryRunProductChange({ plan });
    expect(dryRun.sessionRequired).toBe(true);
    expect(dryRun.sessionAttached).toBe(false);
    expect(dryRun.dryRunFailures[0]).toContain('sessionId is required');
    expect(JSON.stringify(dryRun)).not.toContain('"execute":true');
  });
});

function createItacFixtureXlsx(): string {
  const dir = join(tmpdir(), `itac-xlsx-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const workbookDir = join(dir, 'xl');
  const relDir = join(workbookDir, '_rels');
  const sheetDir = join(workbookDir, 'worksheets');
  mkdirSync(relDir, { recursive: true });
  mkdirSync(sheetDir, { recursive: true });
  writeFileSync(join(dir, '[Content_Types].xml'), `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`);
  mkdirSync(join(dir, '_rels'), { recursive: true });
  writeFileSync(join(dir, '_rels', '.rels'), `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);
  writeFileSync(join(workbookDir, 'workbook.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Updated Sercurity Checklist (2)" sheetId="1" r:id="rId1"/></sheets>
</workbook>`);
  writeFileSync(join(relDir, 'workbook.xml.rels'), `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`);
  writeFileSync(join(sheetDir, 'sheet1.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
${row(3, { G: 'Inspection result', N: 'Assessment Criteria', O: 'Remark' })}
${row(4, {
    B: 'No', C: 'Category', D: 'Soultion', E: 'Item', F: 'Specific details',
    G: 'Internet\n(VPN,F/W,DMZ)', H: 'Office', I: 'Production', J: 'Server',
    K: 'Results', L: 'Reason for Inspection Results'
  })}
${row(5, { B: '1', C: 'Security system', D: 'Anti-Spam', E: 'Malware Infection Prevention', F: 'Block spam and virus emails', G: '△', K: '0.5', L: 'Using SPAMOUT email filtering system controlled by HQ', N: 'Use dedicated spam filtering solution' })}
${row(6, { B: '2', C: 'Security system', D: 'Log retention', E: 'Incident Analysis and Response', F: 'Event logs and audit logs retained at least 1 year', G: '△', K: '0.5', L: 'Logs retained for less than 1 year', N: 'Retain event logs for at least one year' })}
${row(7, { B: '3', C: 'Security system', D: 'Anti-Virus', E: 'Malware Infection Prevention', F: 'Antivirus and EDR installed and running on all PCs and servers', H: '△', K: '0.5', L: 'Need endpoint agent installation status evidence', N: 'Apply to all servers and PCs' })}
${row(8, { B: '4', C: 'Security system', D: 'NDR', E: 'Incident Analysis and Response', F: 'SOAR response action and alert dashboard are validated', H: '△', K: '0.5', L: 'No response playbook evidence', N: 'Validate incident response workflow' })}
${row(9, { B: '5', C: 'Infrastructure', D: 'HCI/SCP', E: 'Availability', F: 'NTP alert, license mismatch, HA and DRS status are verified', H: '△', K: '0.5', L: 'NTP and license mismatch alerts exist', N: 'Resolve license/NTP alerts and validate HA/DRS' })}
${row(10, { B: '6', C: 'Security system', D: 'Anti-Virus', E: 'Malware Infection Prevention', F: 'CrowdStrike and Alyac deployment evidence is required', H: '△', K: '0.5', L: 'Using CrowdStrike and Alyac', N: 'Provide third-party endpoint security evidence' })}
</sheetData></worksheet>`);
  const xlsxPath = join(dir, 'itac-fixture.xlsx');
  execFileSync('zip', ['-qr', xlsxPath, '.'], { cwd: dir });
  return xlsxPath;
}

function row(rowNumber: number, values: Record<string, string>): string {
  const cells = Object.entries(values)
    .map(([column, value]) => `<c r="${column}${rowNumber}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`)
    .join('');
  return `<row r="${rowNumber}">${cells}</row>`;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
