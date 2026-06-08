import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSettingGuidePptx, buildOperationsGuidePptx } from '../packages/sangfor-pptx/src/index.js';

// ─── Test Helpers ───────────────────────────────────────────────────────────

function createItacFixtureXlsx(): string {
  const dir = join(tmpdir(), `itac-pptx-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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
    G: 'Internet\\n(VPN,F/W,DMZ)', H: 'Office', I: 'Production', J: 'Server',
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

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('PPTX Guide Builder', () => {
  it('generates setting guide PPTX from ITAC Excel', async () => {
    const filePath = createItacFixtureXlsx();
    const outDir = join(tmpdir(), `pptx-test-${Date.now()}`);
    mkdirSync(outDir, { recursive: true });
    const outputPath = join(outDir, 'Sangfor_설정가이드_MCP.pptx');

    const result = await buildSettingGuidePptx({ filePath, outputPath });

    expect(result.pptxPath).toBe(outputPath);
    expect(existsSync(outputPath)).toBe(true);
    expect(result.size).toBeGreaterThan(0);
    expect(result.slideCount).toBeGreaterThan(5);
    expect(result.totalItems).toBe(6);
    expect(result.consoleItems).toBe(4);
    expect(result.manualItems).toBe(2);
    expect(result.products).toContain('ENDPOINT_SECURE');
    expect(result.products).toContain('IAG');
    expect(result.products).toContain('NDR');
    expect(result.products).toContain('HCI_SCP');
  });

  it('generates operations guide PPTX', async () => {
    const outDir = join(tmpdir(), `pptx-ops-${Date.now()}`);
    mkdirSync(outDir, { recursive: true });
    const outputPath = join(outDir, 'Sangfor_운영가이드_MCP.pptx');

    const result = await buildOperationsGuidePptx({ outputPath });

    expect(result.pptxPath).toBe(outputPath);
    expect(existsSync(outputPath)).toBe(true);
    expect(result.size).toBeGreaterThan(0);
    expect(result.slideCount).toBe(6);
    expect(result.planId).toBe('ops_guide');
  });

  it('generates PPTX with default output path', async () => {
    const filePath = createItacFixtureXlsx();
    const result = await buildSettingGuidePptx({ filePath });

    expect(existsSync(result.pptxPath)).toBe(true);
    expect(result.pptxPath).toContain('outputs');
    expect(result.pptxPath).toContain('.pptx');
  });

  it('generates PPTX files with reasonable sizes', async () => {
    const filePath = createItacFixtureXlsx();
    const outDir = join(tmpdir(), `pptx-size-${Date.now()}`);
    mkdirSync(outDir, { recursive: true });

    const settingResult = await buildSettingGuidePptx({
      filePath,
      outputPath: join(outDir, 'setting.pptx'),
    });

    const opsResult = await buildOperationsGuidePptx({
      outputPath: join(outDir, 'ops.pptx'),
    });

    // Setting guide should be larger than operations guide (more content)
    expect(settingResult.size).toBeGreaterThan(1000);
    expect(opsResult.size).toBeGreaterThan(500);
  });
});
