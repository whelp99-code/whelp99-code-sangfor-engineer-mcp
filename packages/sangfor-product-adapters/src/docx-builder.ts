import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { generateExcelBasedChangePlan, type ExcelWorkPlanItem, type ExcelBasedChangePlan } from './index.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DocxBuilderInput {
  filePath: string;
  outputPath?: string;
}

export interface DocxBuilderResult {
  docxPath: string;
  size: number;
  sections: string[];
  planId: string;
  totalItems: number;
  consoleItems: number;
  manualItems: number;
}

// ─── XML Helpers ─────────────────────────────────────────────────────────────

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '<w:br/>');
}

function textRuns(text: string, opts: { bold?: boolean; color?: string; size?: number } = {}): string {
  const props = [
    opts.bold ? '<w:b/>' : '',
    opts.color ? `<w:color w:val="${opts.color}"/>` : '',
    opts.size ? `<w:sz w:val="${opts.size}"/>` : ''
  ].join('');
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

function para(text: string, style = 'BodyText', opts: { bold?: boolean; color?: string; size?: number } = {}): string {
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${textRuns(text, opts)}</w:p>`;
}

function bullet(text: string): string {
  return `<w:p><w:pPr><w:pStyle w:val="Bullet"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${textRuns(text)}</w:p>`;
}

function pageBreak(): string {
  return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
}

function table(headers: string[], rows: string[][], widths: number[]): string {
  const grid = widths.map(width => `<w:gridCol w:w="${width}"/>`).join('');
  const rowXml = [
    tableRow(headers, widths, true),
    ...rows.map(row => tableRow(row, widths, false))
  ].join('');
  return `<w:tbl>
    <w:tblPr>
      <w:tblStyle w:val="TableGrid"/>
      <w:tblW w:type="dxa" w:w="9360"/>
      <w:tblInd w:type="dxa" w:w="120"/>
      <w:tblBorders>
        <w:top w:val="single" w:sz="4" w:color="B8C4D4"/>
        <w:left w:val="single" w:sz="4" w:color="B8C4D4"/>
        <w:bottom w:val="single" w:sz="4" w:color="B8C4D4"/>
        <w:right w:val="single" w:sz="4" w:color="B8C4D4"/>
        <w:insideH w:val="single" w:sz="4" w:color="D2DAE5"/>
        <w:insideV w:val="single" w:sz="4" w:color="D2DAE5"/>
      </w:tblBorders>
      <w:tblCellMar>
        <w:top w:w="80" w:type="dxa"/>
        <w:left w:w="120" w:type="dxa"/>
        <w:bottom w:w="80" w:type="dxa"/>
        <w:right w:w="120" w:type="dxa"/>
      </w:tblCellMar>
      <w:tblLayout w:type="fixed"/>
    </w:tblPr>
    <w:tblGrid>${grid}</w:tblGrid>
    ${rowXml}
  </w:tbl>`;
}

function tableRow(cells: string[], widths: number[], header: boolean): string {
  return `<w:tr>${cells.map((cell, index) => tableCell(cell, widths[index], header)).join('')}</w:tr>`;
}

function tableCell(text: string, width: number, header: boolean): string {
  const fill = header ? '<w:shd w:fill="E8EEF5"/>' : '';
  const bold = header ? '<w:b/>' : '';
  return `<w:tc>
    <w:tcPr><w:tcW w:type="dxa" w:w="${width}"/>${fill}<w:vAlign w:val="center"/></w:tcPr>
    <w:p><w:pPr><w:pStyle w:val="TableText"/></w:pPr><w:r><w:rPr>${bold}<w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>
  </w:tc>`;
}

// ─── Data Grouping ───────────────────────────────────────────────────────────

function grouped(items: ExcelWorkPlanItem[]): Record<string, ExcelWorkPlanItem[]> {
  return items.reduce<Record<string, ExcelWorkPlanItem[]>>((acc, item) => {
    acc[item.product] = acc[item.product] ?? [];
    acc[item.product].push(item);
    return acc;
  }, {});
}

function productLabel(product: string): string {
  const labels: Record<string, string> = {
    ENDPOINT_SECURE: 'Endpoint Secure',
    IAG: 'IAG',
    NDR: 'NDR / Cyber Command',
    HCI_SCP: 'HCI / SCP',
    external_or_manual: '수동/외부 증적'
  };
  return labels[product] ?? product;
}

// ─── Document XML Builder ────────────────────────────────────────────────────

function buildDocumentXml(plan: ExcelBasedChangePlan): string {
  const consoleItems = plan.workPlan.filter(item => item.product !== 'external_or_manual');
  const manualItems = plan.workPlan.filter(item => item.product === 'external_or_manual');
  const byProduct = grouped(consoleItems);

  const body: string[] = [];
  body.push(para('Sangfor 제품 설정 Dry-run 가이드', 'TitleText'));
  body.push(para('현대차 감사 체크리스트 기반 고객 제공용 설정 계획서', 'SubtitleText'));
  body.push(para(`문서 기준 계획 ID: ${plan.id}`, 'MetaText'));
  body.push(para('본 문서는 제공된 ITAC 감사 체크리스트를 기준으로 Sangfor 제품 콘솔에서 확인 가능한 설정 항목과 수동/외부 증적 항목을 분리하고, 제품별 메뉴 경로와 dry-run 작업 절차를 제시한다.', 'BodyText'));

  body.push(para('1. 요약', 'Heading1'));
  body.push(table(
    ['구분', '수량', '설명'],
    [
      ['전체 우선 처리 항목', String(plan.workPlan.length), '△, 낮은 점수, 미흡 사유가 있는 감사 항목'],
      ['제품 콘솔 dry-run 대상', String(consoleItems.length), 'Endpoint Secure, IAG, NDR 콘솔에서 현재값과 증적을 확인할 항목'],
      ['수동/외부 증적 대상', String(manualItems.length), 'SPAMOUT, CrowdStrike/Alyac, DLP, 백업 운영 등 Sangfor 콘솔 직접 설정 대상이 아닌 항목'],
      ['실제 변경 수행', '0', '본 단계에서는 Save/Apply/Delete 및 정책 활성화 작업을 수행하지 않음']
    ],
    [2200, 1200, 5960]
  ));

  body.push(para('2. 실행 원칙', 'Heading1'));
  body.push(bullet('작업 범위는 계획 생성, 콘솔 메뉴 이동, 현재 설정 확인, 스크린샷/증적 수집으로 제한한다.'));
  body.push(bullet('Save, Apply, Delete, Commit, Policy Enable, Agent Deployment, SOAR Response Action은 dry-run 단계에서 실행하지 않는다.'));
  body.push(bullet('로컬 Chrome은 CDP 포트로 실행되어야 하며, MCP operator sessionId가 있어야 콘솔 dry-run을 수행한다.'));
  body.push(bullet('수동/외부 증적 대상은 Sangfor 콘솔에 접속하지 않고 별도 시스템 소유자 또는 운영 증적으로 확인한다.'));

  body.push(para('3. 제품별 설정 계획', 'Heading1'));
  for (const product of ['ENDPOINT_SECURE', 'IAG', 'NDR']) {
    const items = byProduct[product] ?? [];
    if (items.length === 0) continue;
    body.push(para(`${productLabel(product)} (${items.length}건)`, 'Heading2'));
    body.push(table(
      ['요청', '메뉴', '설정/확인 항목', '고객 요청 및 현재 Gap', '필요 증적'],
      items.map(item => [
        item.requestId,
        item.menu,
        item.setting,
        `${item.description}\nGap: ${item.currentGap}`,
        item.evidence.join(', ')
      ]),
      [900, 1700, 1700, 2600, 2460]
    ));
  }

  body.push(pageBreak());
  body.push(para('4. 수동/외부 증적 수집 계획', 'Heading1'));
  body.push(para('다음 항목은 현재 범위의 Sangfor 제품 콘솔에서 직접 설정하거나 확인하기 어렵다. 고객 또는 해당 솔루션 운영 담당자로부터 별도 증적을 수집해야 한다.', 'BodyText'));
  body.push(table(
    ['요청', '항목', '고객 요청 및 현재 Gap', '필요 조치'],
    manualItems.map(item => [
      item.requestId,
      item.setting,
      `${item.description}\nGap: ${item.currentGap}`,
      item.dryRunAction
    ]),
    [900, 1600, 4400, 2460]
  ));

  body.push(para('5. Dry-run 수행 절차', 'Heading1'));
  body.push(para('Step 1. Chrome CDP 준비', 'Heading2'));
  body.push(para('Chrome을 remote-debugging-port=9222 옵션으로 실행하고, 대상 제품 콘솔에 로그인한다.', 'BodyText'));
  body.push(para('Step 2. Operator session 생성', 'Heading2'));
  body.push(para('MCP의 sangfor.start_operator_session 도구로 제품, targetUrl, CDP endpoint를 지정한다.', 'BodyText'));
  body.push(para('Step 3. 계획 기반 dry-run 실행', 'Heading2'));
  body.push(para('sangfor.dry_run_product_change에 생성된 계획서와 sessionId를 전달한다. 작업은 메뉴 이동, 현재값 확인, 증적 수집에서 멈춘다.', 'BodyText'));
  body.push(para('Step 4. 결과 검토', 'Heading2'));
  body.push(para('증적이 누락된 항목, 메뉴 미발견 항목, 권한 부족 항목은 고객 확인 필요 사항으로 분리한다.', 'BodyText'));

  body.push(para('6. 고객 확인 필요 사항', 'Heading1'));
  body.push(bullet('Endpoint Secure 콘솔 접근 권한 및 정책 조회 권한'));
  body.push(bullet('IAG 콘솔 접근 권한 및 NAC/접근제어/로그 메뉴 조회 권한'));
  body.push(bullet('NDR 또는 Cyber Command 콘솔 접근 권한 및 이벤트 소스/로그 관리 메뉴 조회 권한'));
  body.push(bullet('SPAMOUT, CrowdStrike, Alyac, DLP, 백업 운영 관련 별도 증적 제공 담당자'));

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    ${body.join('\n')}
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;
}

// ─── Static XML Constants ────────────────────────────────────────────────────

const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Malgun Gothic"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="BodyText"><w:name w:val="Body Text"/><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Malgun Gothic"/><w:sz w:val="22"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="TitleText"><w:name w:val="Title Text"/><w:pPr><w:spacing w:after="120"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Malgun Gothic"/><w:b/><w:color w:val="0B2545"/><w:sz w:val="40"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="SubtitleText"><w:name w:val="Subtitle Text"/><w:pPr><w:spacing w:after="160"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Malgun Gothic"/><w:color w:val="555555"/><w:sz w:val="24"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="MetaText"><w:name w:val="Meta Text"/><w:pPr><w:spacing w:after="120"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Malgun Gothic"/><w:color w:val="555555"/><w:sz w:val="20"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:spacing w:before="360" w:after="200"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Malgun Gothic"/><w:b/><w:color w:val="2E74B5"/><w:sz w:val="32"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:spacing w:before="280" w:after="140"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Malgun Gothic"/><w:b/><w:color w:val="2E74B5"/><w:sz w:val="26"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Bullet"><w:name w:val="Bullet"/><w:pPr><w:spacing w:after="80" w:line="300" w:lineRule="auto"/><w:ind w:left="540" w:hanging="270"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Malgun Gothic"/><w:sz w:val="22"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Table Text"/><w:pPr><w:spacing w:after="0" w:line="280" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Malgun Gothic"/><w:sz w:val="18"/></w:rPr></w:style>
  <w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="B8C4D4"/><w:left w:val="single" w:sz="4" w:color="B8C4D4"/><w:bottom w:val="single" w:sz="4" w:color="B8C4D4"/><w:right w:val="single" w:sz="4" w:color="B8C4D4"/><w:insideH w:val="single" w:sz="4" w:color="D2DAE5"/><w:insideV w:val="single" w:sz="4" w:color="D2DAE5"/></w:tblBorders></w:tblPr></w:style>
</w:styles>`;

const numberingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="540"/></w:tabs><w:ind w:left="540" w:hanging="270"/></w:pPr></w:lvl></w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;

const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const documentRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;

const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>`;

// ─── Main Export ─────────────────────────────────────────────────────────────

export function buildSettingGuideDocx(input: DocxBuilderInput): DocxBuilderResult {
  const plan = generateExcelBasedChangePlan({ filePath: input.filePath, prioritizeOnly: true });
  const consoleItems = plan.workPlan.filter(item => item.product !== 'external_or_manual');
  const manualItems = plan.workPlan.filter(item => item.product === 'external_or_manual');

  const outDir = input.outputPath
    ? dirname(input.outputPath)
    : join(process.cwd(), 'outputs/customer-setting-guide');
  const docxPath = input.outputPath ?? join(outDir, 'sangfor-customer-setting-guide.docx');
  const workDir = join(outDir, 'docx-work');

  // Clean and create work directory
  if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  mkdirSync(join(workDir, '_rels'), { recursive: true });
  mkdirSync(join(workDir, 'word/_rels'), { recursive: true });

  // Write all XML parts
  writeFileSync(join(workDir, '[Content_Types].xml'), contentTypesXml);
  writeFileSync(join(workDir, '_rels/.rels'), relsXml);
  writeFileSync(join(workDir, 'word/document.xml'), buildDocumentXml(plan));
  writeFileSync(join(workDir, 'word/styles.xml'), stylesXml);
  writeFileSync(join(workDir, 'word/numbering.xml'), numberingXml);
  writeFileSync(join(workDir, 'word/_rels/document.xml.rels'), documentRelsXml);

  // Create docx zip
  if (existsSync(docxPath)) rmSync(docxPath);
  execFileSync('zip', ['-qr', docxPath, '.'], { cwd: workDir });

  // Get file size
  const stat = statSync(docxPath);

  // Determine sections present
  const sections: string[] = ['1. 요약', '2. 실행 원칙', '3. 제품별 설정 계획'];
  const groupedItems = grouped(consoleItems);
  if (groupedItems['ENDPOINT_SECURE']?.length) sections.push('3a. Endpoint Secure');
  if (groupedItems['IAG']?.length) sections.push('3b. IAG');
  if (groupedItems['NDR']?.length) sections.push('3c. NDR / Cyber Command');
  sections.push('4. 수동/외부 증적 수집 계획', '5. Dry-run 수행 절차', '6. 고객 확인 필요 사항');

  // Cleanup work dir
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }

  return {
    docxPath,
    size: stat.size,
    sections,
    planId: plan.id,
    totalItems: plan.workPlan.length,
    consoleItems: consoleItems.length,
    manualItems: manualItems.length,
  };
}
