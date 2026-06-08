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

// ─── Operations Guide DOCX Builder ──────────────────────────────────────────

function buildOperationsGuideDocumentXml(): string {
  const body: string[] = [];

  // Title page
  body.push(para('Sangfor 제품 운영 가이드', 'TitleText'));
  body.push(para('일일/주간/월간 모니터링, 장애 대응, 보안 정책 관리 절차', 'SubtitleText'));
  body.push(para('문서 기준: MCP 자동 생성', 'MetaText'));
  body.push(para('본 문서는 Sangfor 제품(Endpoint Secure, IAG, NDR/Cyber Command, HCI/SCP)의 운영 절차를 정리하여, 일일 모니터링부터 장애 대응 및 보안 정책 관리까지의 표준 운영 프로세스를 제시한다.', 'BodyText'));

  body.push(pageBreak());

  // Section 1: Daily Monitoring
  body.push(para('1. 일일 모니터링 절차', 'Heading1'));
  body.push(para('일일 모니터링은 제품 콘솔의 대시보드를 확인하고, 로그를 검토하며, 알림 설정 상태를 점검하는 절차로 구성된다.', 'BodyText'));

  body.push(para('1.1 대시보드 확인', 'Heading2'));
  body.push(para('각 제품 콘솔에 로그인하여 메인 대시보드의 상태 요약을 확인한다.', 'BodyText'));
  body.push(bullet('Endpoint Secure: 에이전트 온라인/오프라인 현황, 탐지/격리 이벤트 수'));
  body.push(bullet('IAG: 인터넷 접근 현황, 인증 소스 상태, 정책 위반 건수'));
  body.push(bullet('NDR / Cyber Command: 이벤트 소스 연결 상태, 인시던트/알림 건수, SOAR 플레이북 실행 결과'));
  body.push(bullet('HCI / SCP: 클러스터 리소스 사용률, VM 상태, 스토리지 용량'));

  body.push(para('1.2 로그 검토', 'Heading2'));
  body.push(para('각 제품의 로그 메뉴에서 전일 로그를 검토하고, 이상 항목을 식별한다.', 'BodyText'));
  body.push(bullet('Endpoint Secure: 탐지 로그, 보호 정책 위반 로그, 에이전트 업데이트 이력'));
  body.push(bullet('IAG: 인터넷 접근 로그, 인증 실패 로그, URL/어플리케이션 제어 로그'));
  body.push(bullet('NDR: 이벤트 소스 수집 로그, 인시던트 상세, 알림 규칙 발동 이력'));
  body.push(bullet('HCI / SCP: 태스크 이력, 알림 로그, 시스템 이벤트'));

  body.push(para('1.3 알림 설정 확인', 'Heading2'));
  body.push(para('알림 채널(이메일, Syslog, Webhook)이 올바르게 구성되어 있는지 확인한다.', 'BodyText'));
  body.push(bullet('알림 규칙이 활성화 상태인지 확인'));
  body.push(bullet('알림 채널(이메일/Syslog/Webhook) 연결 상태 점검'));
  body.push(bullet('알림 레벨(정보/주의/위험)별 필터링 설정 확인'));
  body.push(bullet('알림 수신 담당자 목록 업데이트 여부 확인'));

  body.push(table(
    ['항목', '확인 방법', '이상 시 조치'],
    [
      ['에이전트 오프라인', 'Endpoint Secure > Assets > Agent List에서 오프라인 에이전트 확인', '에이전트 재시작 또는 네트워크 연결 확인'],
      ['인증 실패 급증', 'IAG > Logs에서 인증 실패 로그 빈도 확인', '공격 의심 시 IP 차단 및 보안팀 통보'],
      ['이벤트 소스 끊김', 'NDR > Events > Event Sources에서 연결 상태 확인', 'Syslog/API 소스 재연결 및 네트워크 점검'],
      ['리소스 사용률 초과', 'HCI/SCP 대시보드에서 리소스 풀 사용률 확인', '리소스 추가 또는 VM 마이그레이션 검토'],
    ],
    [2200, 3600, 3560]
  ));

  body.push(pageBreak());

  // Section 2: Weekly/Monthly Inspection
  body.push(para('2. 주간/월간 정기 점검', 'Heading1'));
  body.push(para('정기 점검은 업데이트, 백업 검증, 보안 정책 리뷰를 포함한다.', 'BodyText'));

  body.push(para('2.1 업데이트 점검 (주간)', 'Heading2'));
  body.push(bullet('Endpoint Secure: 시그니처 DB 업데이트 일자 및 버전 확인'));
  body.push(bullet('IAG: 펌웨어/소프트웨어 업데이트 가능 버전 확인'));
  body.push(bullet('NDR: 센서/커넥터 펌웨어 및 탐지 규칙 업데이트 확인'));
  body.push(bullet('HCI / SCP: 펌웨어 패치 및 보안 업데이트 상태 확인'));

  body.push(para('2.2 백업 검증 (주간)', 'Heading2'));
  body.push(bullet('HCI/SCP: VM 스냅샷 및 설정 백업 존재 여부 확인'));
  body.push(bullet('IAG: 설정 백업 파일 생성 및 유효성 확인'));
  body.push(bullet('NDR: 플레이북 및 알림 규칙 설정 내보내기 확인'));
  body.push(bullet('복원 테스트: 분기 1회 백업 파일 복원 테스트 수행'));

  body.push(para('2.3 보안 정책 리뷰 (월간)', 'Heading2'));
  body.push(bullet('Endpoint Secure: 보호 정책 예외 목록 리뷰 및 불필요 항목 제거'));
  body.push(bullet('IAG: 접근 제어 정책, URL 필터링 규칙 정합성 확인'));
  body.push(bullet('NDR: 인시던트 대응 플레이북 유효성 검증'));
  body.push(bullet('전체 제품: 감사 로그 내 권한 변경 이력 리뷰'));

  body.push(table(
    ['주기', '점검 항목', '검증 방법', '담당'],
    [
      ['주간', '시그니처/펌웨어 업데이트', '각 제품 콘솔 System/Update 메뉴 확인', '보안 운영'],
      ['주간', '백업 파일 존재 및 유효성', '백업 저장소에서 파일 목록 확인', '인프라 운영'],
      ['월간', '보안 정책 예외 목록', '각 제품 정책 메뉴에서 예외 항목 리뷰', '보안 담당'],
      ['월간', '감사 로그 권한 변경', '시스템 감사 로그에서 사용자 권한 변경 이력 검토', '보안 담당'],
    ],
    [1200, 2400, 3560, 2200]
  ));

  body.push(pageBreak());

  // Section 3: Incident Response
  body.push(para('3. 장애 대응 절차', 'Heading1'));
  body.push(para('장애 발생 시 신속한 알림 처리, 벤더 지원, 복구 절차를 따른다.', 'BodyText'));

  body.push(para('3.1 알림 처리', 'Heading2'));
  body.push(bullet('1단계: 알림 수신 및 분류 (정보/주의/위험 레벨 확인)'));
  body.push(bullet('2단계: 위험 레벨 알림은 즉시 담당자에게 통보'));
  body.push(bullet('3단계: 알림 상세 정보(제품, 메뉴, 대상, 발생 시간) 기록'));
  body.push(bullet('4단계: 자가 처리 가능한 경우 즉시 조치, 불가능 시 벤더 지원 요청'));

  body.push(para('3.2 벤더 지원 요청', 'Heading2'));
  body.push(bullet('Sangfor 기술 지원 포털(tac.sangfor.com)을 통해 지원 요청'));
  body.push(bullet('필요 정보: 제품 버전, 시리얼 번호, 장애 현상, 재현 절차, 로그 파일'));
  body.push(bullet('긴급 장애: Sangfor TAC 핫라인 연락'));
  body.push(bullet('지원 티켓 상태 모니터링 및 추가 정보 제공'));

  body.push(para('3.3 복구 절차', 'Heading2'));
  body.push(bullet('1단계: 장애 원인 분석 및 영향 범위 파악'));
  body.push(bullet('2단계: 백업/스냅샷에서 복원 또는 설정 롤백'));
  body.push(bullet('3단계: 복구 후 정상 동작 검증'));
  body.push(bullet('4단계: 장애 보고서 작성 및 레슨러닝 기록'));

  body.push(table(
    ['장애 유형', '초기 대응', '복구 방법', 'RTO 목표'],
    [
      ['에이전트 오프라인 다수', '에이전트 상태 확인 → 네트워크 점검', '에이전트 재배포 또는 네트워크 복구', '4시간'],
      ['IAG 인증 서비스 장애', '인증 소스 상태 확인 → 로그 분석', '인증 소스 재시작 또는 설정 롤백', '2시간'],
      ['NDR 인시던트 폭증', '알림 필터링 → 인시던트 분류', '플레이북 수정 또는 규칙 조정', '1시간'],
      ['HCI 클러스터 장애', '노드 상태 확인 → HA 페일오버', '노드 복구 또는 리소스 재배치', '2시간'],
    ],
    [2200, 2600, 2600, 1960]
  ));

  body.push(pageBreak());

  // Section 4: Security Policy Management
  body.push(para('4. 보안 정책 관리', 'Heading1'));
  body.push(para('접근 제어, 감사 로그, 정책 변경 관리 절차를 정의한다.', 'BodyText'));

  body.push(para('4.1 접근 제어', 'Heading2'));
  body.push(bullet('관리자 계정은 최소 권한 원칙 적용'));
  body.push(bullet('제품별 관리자 역할 분리 (보안 운영, 인프라 운영, 감사)'));
  body.push(bullet('공유 계정 사용 금지, 개인 계정 사용 필수'));
  body.push(bullet('비밀번호 정책: 90일 변경 주기, 복잡도 요구사항 적용'));
  body.push(bullet('VPN/원격 접속 시 다因素 인증(MFA) 적용'));

  body.push(para('4.2 감사 로그', 'Heading2'));
  body.push(bullet('각 제품의 감사 로그를 중앙 Syslog 서버로 전송'));
  body.push(bullet('감사 로그 보존 기간: 최소 1년'));
  body.push(bullet('월간 감사 로그 리뷰 및 이상 이력 식별'));
  body.push(bullet('감사 로그 무결성 검증(로그 위변조 방지)'));

  body.push(para('4.3 정책 변경 관리', 'Heading2'));
  body.push(bullet('정책 변경은 반드시 변경 관리 티켓 발급 후 수행'));
  body.push(bullet('변경 전 현재 설정 백업 필수'));
  body.push(bullet('변경 후 영향 분석 및 검증 수행'));
  body.push(bullet('변경 이력 문서화 및 감사 로그 기록'));

  body.push(table(
    ['관리 항목', '기준', '주기', '담당'],
    [
      ['관리자 계정 리뷰', '최소 권한 원칙 적용 여부', '월간', '보안 담당'],
      ['비밀번호 정책', '90일 변경, 복잡도 요구사항', '상시 (시스템 적용)', '보안 담당'],
      ['감사 로그 백업', '최소 1년 보존, 무결성 검증', '월간', '인프라 운영'],
      ['정책 변경 이력', '변경 관리 티켓 연결, 백업 존재', '변경 시마다', '보안 운영'],
      ['접근 권한 변경', '권한 추가/제거 이력 기록', '월간 리뷰', '보안 담당'],
    ],
    [2200, 2800, 1800, 2560]
  ));

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

export function buildOperationsGuideDocx(input: { outputPath?: string }): DocxBuilderResult {
  const outDir = input.outputPath
    ? dirname(input.outputPath)
    : join(process.cwd(), 'outputs/customer-operations-guide');
  const docxPath = input.outputPath ?? join(outDir, 'sangfor-operations-guide.docx');
  const workDir = join(outDir, 'docx-ops-work');

  // Clean and create work directory
  if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  mkdirSync(join(workDir, '_rels'), { recursive: true });
  mkdirSync(join(workDir, 'word/_rels'), { recursive: true });

  // Write all XML parts
  writeFileSync(join(workDir, '[Content_Types].xml'), contentTypesXml);
  writeFileSync(join(workDir, '_rels/.rels'), relsXml);
  writeFileSync(join(workDir, 'word/document.xml'), buildOperationsGuideDocumentXml());
  writeFileSync(join(workDir, 'word/styles.xml'), stylesXml);
  writeFileSync(join(workDir, 'word/numbering.xml'), numberingXml);
  writeFileSync(join(workDir, 'word/_rels/document.xml.rels'), documentRelsXml);

  // Create docx zip
  if (existsSync(docxPath)) rmSync(docxPath);
  execFileSync('zip', ['-qr', docxPath, '.'], { cwd: workDir });

  // Get file size
  const stat = statSync(docxPath);

  // Cleanup work dir
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }

  return {
    docxPath,
    size: stat.size,
    sections: [
      '1. 일일 모니터링 절차',
      '1.1 대시보드 확인',
      '1.2 로그 검토',
      '1.3 알림 설정 확인',
      '2. 주간/월간 정기 점검',
      '2.1 업데이트 점검',
      '2.2 백업 검증',
      '2.3 보안 정책 리뷰',
      '3. 장애 대응 절차',
      '3.1 알림 처리',
      '3.2 벤더 지원 요청',
      '3.3 복구 절차',
      '4. 보안 정책 관리',
      '4.1 접근 제어',
      '4.2 감사 로그',
      '4.3 정책 변경 관리',
    ],
    planId: 'ops-guide-static',
    totalItems: 0,
    consoleItems: 0,
    manualItems: 0,
  };
}
