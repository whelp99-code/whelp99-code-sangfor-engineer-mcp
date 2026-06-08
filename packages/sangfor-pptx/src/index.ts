/**
 * Sangfor PPTX Guide Builder — Generates .pptx setting and operations guides
 * using pptxgenjs. Data comes from the Excel-based change plan pipeline.
 */
import PptxGenJS from 'pptxgenjs';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { generateExcelBasedChangePlan, type ExcelBasedChangePlan, type ExcelWorkPlanItem } from '@sangfor/product-adapters';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PptxGuideOptions {
  filePath?: string;
  outputPath?: string;
  plan?: ExcelBasedChangePlan;
  screenshotDir?: string;
}

export interface PptxGuideResult {
  pptxPath: string;
  size: number;
  slideCount: number;
  planId: string;
  totalItems: number;
  consoleItems: number;
  manualItems: number;
  products: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PptxInstance = any;

// ─── Constants ──────────────────────────────────────────────────────────────

const COLORS = {
  primary: '0B2545',
  secondary: '2E74B5',
  accent: '4472C4',
  bg: 'FFFFFF',
  bgLight: 'F2F7FC',
  text: '333333',
  textLight: '666666',
  white: 'FFFFFF',
  tableBorder: 'B8C4D4',
  tableHeaderBg: '2E74B5',
  tableRowAlt: 'F2F7FC',
  green: '548235',
  orange: 'ED7D31',
  red: 'C00000',
};

const PRODUCT_COLORS: Record<string, string> = {
  ENDPOINT_SECURE: '548235',
  IAG: '2E74B5',
  NDR: 'ED7D31',
  HCI_SCP: '7030A0',
  external_or_manual: '888888',
};

const PRODUCT_LABELS: Record<string, string> = {
  ENDPOINT_SECURE: 'Endpoint Secure',
  IAG: 'IAG',
  NDR: 'NDR / Cyber Command',
  HCI_SCP: 'HCI / SCP',
  external_or_manual: '수동/외부 증적',
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function grouped(items: ExcelWorkPlanItem[]): Record<string, ExcelWorkPlanItem[]> {
  return items.reduce<Record<string, ExcelWorkPlanItem[]>>((acc, item) => {
    acc[item.product] = acc[item.product] ?? [];
    acc[item.product].push(item);
    return acc;
  }, {});
}

function addTitleSlide(pptx: PptxInstance, title: string, subtitle: string) {
  const slide = pptx.addSlide();
  slide.background = { color: COLORS.primary };
  slide.addText(title, {
    x: 0.5, y: 1.5, w: 9, h: 1.2,
    fontSize: 32, fontFace: 'Calibri', color: COLORS.white, bold: true,
    align: 'center',
  });
  slide.addText(subtitle, {
    x: 0.5, y: 2.8, w: 9, h: 0.6,
    fontSize: 16, fontFace: 'Calibri', color: 'AABBCC',
    align: 'center',
  });
  slide.addText(`생성일: ${new Date().toISOString().split('T')[0]}`, {
    x: 0.5, y: 3.6, w: 9, h: 0.4,
    fontSize: 11, fontFace: 'Calibri', color: '8899AA',
    align: 'center',
  });
}

function addSummarySlide(pptx: PptxInstance, plan: ExcelBasedChangePlan) {
  const consoleItems = plan.workPlan.filter(i => i.product !== 'external_or_manual');
  const manualItems = plan.workPlan.filter(i => i.product === 'external_or_manual');
  const byProduct = grouped(consoleItems);

  const slide = pptx.addSlide();
  slide.addText('요약', {
    x: 0.5, y: 0.3, w: 9, h: 0.6,
    fontSize: 24, fontFace: 'Calibri', color: COLORS.primary, bold: true,
  });

  const summaryRows = [
    ['전체 우선 처리 항목', String(plan.workPlan.length), '△, 낮은 점수, 미흡 사유가 있는 감사 항목'],
    ['제품 콘솔 dry-run 대상', String(consoleItems.length), '콘솔에서 확인 가능한 항목'],
    ['수동/외부 증적 대상', String(manualItems.length), 'Sangfor 콘솔 외 항목'],
    ['실제 변경 수행', '0', '본 단계에서는 변경 작업 미수행'],
  ];

  slide.addTable(
    [
      [
        { text: '구분', options: { bold: true, color: COLORS.white, fill: { color: COLORS.tableHeaderBg } } },
        { text: '수량', options: { bold: true, color: COLORS.white, fill: { color: COLORS.tableHeaderBg } } },
        { text: '설명', options: { bold: true, color: COLORS.white, fill: { color: COLORS.tableHeaderBg } } },
      ],
      ...summaryRows.map((row, i) => row.map(cell => ({
        text: cell,
        options: { fill: { color: i % 2 === 1 ? COLORS.tableRowAlt : COLORS.white } },
      }))),
    ],
    {
      x: 0.5, y: 1.1, w: 9, h: 2.4,
      fontSize: 11, fontFace: 'Calibri', color: COLORS.text,
      border: { type: 'solid', pt: 0.5, color: COLORS.tableBorder },
      colW: [2.5, 1.2, 5.3],
      autoPage: false,
    }
  );

  // Product distribution chart
  const productSummary = Object.entries(byProduct).map(([product, items]) => ({
    product: PRODUCT_LABELS[product] ?? product,
    count: items.length,
    color: PRODUCT_COLORS[product] ?? '666666',
  }));

  if (productSummary.length > 0) {
    slide.addText('제품별 분포', {
      x: 0.5, y: 3.7, w: 9, h: 0.4,
      fontSize: 14, fontFace: 'Calibri', color: COLORS.secondary, bold: true,
    });

    const barData = productSummary.map(ps => ({
      name: ps.product,
      labels: [ps.product],
      values: [ps.count],
    }));

    slide.addChart(pptx.ChartType?.BAR ?? pptx.charts?.BAR ?? 'bar', barData, {
      x: 0.5, y: 4.1, w: 9, h: 2.2,
      showTitle: false,
      showValue: true,
      valueFontSize: 10,
      catAxisLabelFontSize: 10,
      valAxisLabelFontSize: 9,
      chartColors: productSummary.map(ps => ps.color),
    });
  }
}

function addProductSlide(
  pptx: PptxInstance,
  product: string,
  items: ExcelWorkPlanItem[],
  screenshotDir?: string,
) {
  const label = PRODUCT_LABELS[product] ?? product;
  const color = PRODUCT_COLORS[product] ?? '666666';

  // Product header slide
  const headerSlide = pptx.addSlide();
  headerSlide.background = { color };
  headerSlide.addText(label, {
    x: 0.5, y: 2.0, w: 9, h: 1.0,
    fontSize: 30, fontFace: 'Calibri', color: COLORS.white, bold: true,
    align: 'center',
  });
  headerSlide.addText(`${items.length}건의 설정 항목`, {
    x: 0.5, y: 3.1, w: 9, h: 0.6,
    fontSize: 16, fontFace: 'Calibri', color: 'CCDDEE',
    align: 'center',
  });

  // Detail slides (chunk items into groups of 5)
  const CHUNK_SIZE = 5;
  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    const chunk = items.slice(i, i + CHUNK_SIZE);
    const slide = pptx.addSlide();

    slide.addText(`${label} — 설정 항목 (${i + 1}~${Math.min(i + CHUNK_SIZE, items.length)}/${items.length})`, {
      x: 0.3, y: 0.2, w: 9.4, h: 0.5,
      fontSize: 14, fontFace: 'Calibri', color: color, bold: true,
    });

    const tableRows = [
      [
        { text: '요청', options: { bold: true, color: COLORS.white, fill: { color: color }, fontSize: 9 } },
        { text: '메뉴 경로', options: { bold: true, color: COLORS.white, fill: { color: color }, fontSize: 9 } },
        { text: '설정 항목', options: { bold: true, color: COLORS.white, fill: { color: color }, fontSize: 9 } },
        { text: '확인 방법', options: { bold: true, color: COLORS.white, fill: { color: color }, fontSize: 9 } },
      ],
      ...chunk.map((item, idx) => [
        { text: item.requestId, options: { fontSize: 8, fill: { color: idx % 2 === 1 ? COLORS.tableRowAlt : COLORS.white } } },
        { text: item.menu, options: { fontSize: 8, fill: { color: idx % 2 === 1 ? COLORS.tableRowAlt : COLORS.white } } },
        { text: item.setting, options: { fontSize: 8, fill: { color: idx % 2 === 1 ? COLORS.tableRowAlt : COLORS.white } } },
        { text: item.evidence.join(', '), options: { fontSize: 8, fill: { color: idx % 2 === 1 ? COLORS.tableRowAlt : COLORS.white } } },
      ]),
    ];

    slide.addTable(tableRows, {
      x: 0.3, y: 0.8, w: 9.4, h: 4.5,
      fontSize: 9, fontFace: 'Calibri', color: COLORS.text,
      border: { type: 'solid', pt: 0.5, color: COLORS.tableBorder },
      colW: [1.3, 2.5, 2.8, 2.8],
      autoPage: false,
    });

    // Add screenshot placeholder if screenshotDir exists
    if (screenshotDir) {
      const screenshotPath = join(screenshotDir, product.toLowerCase(), `slide_${i}.png`);
      if (existsSync(screenshotPath)) {
        slide.addImage({
          path: screenshotPath,
          x: 6.5, y: 5.5, w: 3.0, h: 1.8,
        });
      }
    }
  }
}

function addManualEvidenceSlide(pptx: PptxInstance, items: ExcelWorkPlanItem[]) {
  if (items.length === 0) return;

  const slide = pptx.addSlide();
  slide.addText('수동/외부 증적 수집 계획', {
    x: 0.3, y: 0.2, w: 9.4, h: 0.5,
    fontSize: 18, fontFace: 'Calibri', color: COLORS.primary, bold: true,
  });

  slide.addText('다음 항목은 Sangfor 제품 콘솔에서 직접 설정하거나 확인하기 어렵다. 고객 또는 해당 솔루션 운영 담당자로부터 별도 증적을 수집해야 한다.', {
    x: 0.3, y: 0.8, w: 9.4, h: 0.4,
    fontSize: 10, fontFace: 'Calibri', color: COLORS.textLight,
  });

  const tableRows = [
    [
      { text: '요청', options: { bold: true, color: COLORS.white, fill: { color: COLORS.tableHeaderBg }, fontSize: 9 } },
      { text: '항목', options: { bold: true, color: COLORS.white, fill: { color: COLORS.tableHeaderBg }, fontSize: 9 } },
      { text: '요청 및 Gap', options: { bold: true, color: COLORS.white, fill: { color: COLORS.tableHeaderBg }, fontSize: 9 } },
      { text: '필요 조치', options: { bold: true, color: COLORS.white, fill: { color: COLORS.tableHeaderBg }, fontSize: 9 } },
    ],
    ...items.slice(0, 10).map((item, idx) => [
      { text: item.requestId, options: { fontSize: 8, fill: { color: idx % 2 === 1 ? COLORS.tableRowAlt : COLORS.white } } },
      { text: item.setting, options: { fontSize: 8, fill: { color: idx % 2 === 1 ? COLORS.tableRowAlt : COLORS.white } } },
      { text: `${item.description.substring(0, 60)}...`, options: { fontSize: 8, fill: { color: idx % 2 === 1 ? COLORS.tableRowAlt : COLORS.white } } },
      { text: item.dryRunAction.substring(0, 80), options: { fontSize: 8, fill: { color: idx % 2 === 1 ? COLORS.tableRowAlt : COLORS.white } } },
    ]),
  ];

  slide.addTable(tableRows, {
    x: 0.3, y: 1.3, w: 9.4, h: 4.5,
    fontSize: 9, fontFace: 'Calibri', color: COLORS.text,
    border: { type: 'solid', pt: 0.5, color: COLORS.tableBorder },
    colW: [1.0, 2.0, 3.5, 2.9],
    autoPage: false,
  });
}

function addDryRunSlide(pptx: PptxInstance) {
  const slide = pptx.addSlide();
  slide.addText('Dry-run 수행 절차', {
    x: 0.3, y: 0.2, w: 9.4, h: 0.5,
    fontSize: 18, fontFace: 'Calibri', color: COLORS.primary, bold: true,
  });

  const steps = [
    ['Step 1', 'Chrome CDP 준비', 'Chrome을 remote-debugging-port=9333 옵션으로 실행하고, 대상 제품 콘솔에 로그인한다.'],
    ['Step 2', 'Operator session 생성', 'MCP의 sangfor.start_operator_session 도구로 제품, targetUrl, CDP endpoint를 지정한다.'],
    ['Step 3', '계획 기반 dry-run 실행', 'sangfor.dry_run_product_change에 생성된 계획서와 sessionId를 전달한다.'],
    ['Step 4', '결과 검토', '증적이 누락된 항목, 메뉴 미발견 항목은 고객 확인 필요 사항으로 분리한다.'],
  ];

  steps.forEach((step, i) => {
    const y = 0.9 + i * 1.2;
    slide.addShape(pptx.ShapeType?.ROUNDED_RECTANGLE ?? pptx.shapes?.ROUNDED_RECTANGLE ?? 'roundRect', {
      x: 0.3, y, w: 1.2, h: 0.9,
      fill: { color: COLORS.secondary },
      rectRadius: 0.1,
    });
    slide.addText(step[0], {
      x: 0.3, y, w: 1.2, h: 0.9,
      fontSize: 11, fontFace: 'Calibri', color: COLORS.white, bold: true,
      align: 'center', valign: 'middle',
    });
    slide.addText(step[1], {
      x: 1.7, y, w: 2.5, h: 0.45,
      fontSize: 12, fontFace: 'Calibri', color: COLORS.primary, bold: true,
    });
    slide.addText(step[2], {
      x: 1.7, y: y + 0.4, w: 7.5, h: 0.5,
      fontSize: 10, fontFace: 'Calibri', color: COLORS.textLight,
    });
  });
}

function addCustomerChecklistSlide(pptx: PptxInstance) {
  const slide = pptx.addSlide();
  slide.addText('고객 확인 필요 사항', {
    x: 0.3, y: 0.2, w: 9.4, h: 0.5,
    fontSize: 18, fontFace: 'Calibri', color: COLORS.primary, bold: true,
  });

  const items = [
    'Endpoint Secure 콘솔 접근 권한 및 정책 조회 권한',
    'IAG 콘솔 접근 권한 및 NAC/접근제어/로그 메뉴 조회 권한',
    'NDR 또는 Cyber Command 콘솔 접근 권한 및 이벤트 소스/로그 관리 메뉴 조회 권한',
    'SPAMOUT, CrowdStrike, Alyac, DLP, 백업 운영 관련 별도 증적 제공 담당자',
    'HCI/SCP 콘솔 접근 권한 및 리소스/VM/HA/DRS 메뉴 조회 권한',
  ];

  items.forEach((item, i) => {
    const y = 1.0 + i * 0.7;
    slide.addShape(pptx.ShapeType?.ROUNDED_RECTANGLE ?? pptx.shapes?.ROUNDED_RECTANGLE ?? 'roundRect', {
      x: 0.5, y, w: 0.4, h: 0.4,
      fill: { color: COLORS.green },
      rectRadius: 0.05,
    });
    slide.addText(`✓`, {
      x: 0.5, y, w: 0.4, h: 0.4,
      fontSize: 14, fontFace: 'Calibri', color: COLORS.white,
      align: 'center', valign: 'middle',
    });
    slide.addText(item, {
      x: 1.1, y, w: 8.2, h: 0.4,
      fontSize: 12, fontFace: 'Calibri', color: COLORS.text,
      valign: 'middle',
    });
  });
}

// ─── Operations Guide Slides ────────────────────────────────────────────────

function addOpsTitleSlide(pptx: PptxInstance) {
  const slide = pptx.addSlide();
  slide.background = { color: COLORS.primary };
  slide.addText('Sangfor 제품 운영 가이드', {
    x: 0.5, y: 1.5, w: 9, h: 1.2,
    fontSize: 32, fontFace: 'Calibri', color: COLORS.white, bold: true,
    align: 'center',
  });
  slide.addText('일일 모니터링 · 주간/월간 점검 · 장애 대응 · 보안 정책', {
    x: 0.5, y: 2.8, w: 9, h: 0.6,
    fontSize: 16, fontFace: 'Calibri', color: 'AABBCC',
    align: 'center',
  });
  slide.addText(`생성일: ${new Date().toISOString().split('T')[0]}`, {
    x: 0.5, y: 3.6, w: 9, h: 0.4,
    fontSize: 11, fontFace: 'Calibri', color: '8899AA',
    align: 'center',
  });
}

function addDailyMonitoringSlide(pptx: PptxInstance) {
  const slide = pptx.addSlide();
  slide.addText('일일 모니터링 절차', {
    x: 0.3, y: 0.2, w: 9.4, h: 0.5,
    fontSize: 18, fontFace: 'Calibri', color: COLORS.primary, bold: true,
  });

  const rows = [
    [
      { text: '제품', options: { bold: true, color: COLORS.white, fill: { color: COLORS.tableHeaderBg }, fontSize: 10 } },
      { text: '모니터링 항목', options: { bold: true, color: COLORS.white, fill: { color: COLORS.tableHeaderBg }, fontSize: 10 } },
      { text: '확인 방법', options: { bold: true, color: COLORS.white, fill: { color: COLORS.tableHeaderBg }, fontSize: 10 } },
      { text: '알림 기준', options: { bold: true, color: COLORS.white, fill: { color: COLORS.tableHeaderBg }, fontSize: 10 } },
    ],
    ...([
      ['Endpoint Secure', '에이전트 온라인율, 업데이트 상태', 'Dashboard > Endpoint Status', '오프라인 에이전트 > 5%'],
      ['IAG', '인터넷 접근 로그, 이상 트래픽', 'Logs > Internet Access Logs', '비정상 트래픽 급증'],
      ['NDR/Cyber Command', '보안 이벤트, 알림 규칙 발동', 'Dashboard > Security Operations', 'Critical 알림 즉시 처리'],
      ['HCI/SCP', '노드 상태, 리소스 사용률, 라이선스', 'Home > Overview, System > Licensing', 'CPU/Memory > 85%'],
    ].map((row, i) => row.map(cell => ({
      text: cell,
      options: { fontSize: 9, fill: { color: i % 2 === 1 ? COLORS.tableRowAlt : COLORS.white } },
    })))),
  ];

  slide.addTable(rows, {
    x: 0.3, y: 0.8, w: 9.4, h: 3.0,
    fontSize: 9, fontFace: 'Calibri', color: COLORS.text,
    border: { type: 'solid', pt: 0.5, color: COLORS.tableBorder },
    colW: [1.8, 2.8, 2.8, 2.0],
    autoPage: false,
  });

  slide.addText('모니터링 체크리스트', {
    x: 0.3, y: 4.0, w: 9.4, h: 0.4,
    fontSize: 12, fontFace: 'Calibri', color: COLORS.secondary, bold: true,
  });

  const checklist = [
    '□ 대시보드 로그인 후 전체 현황 확인',
    '□ 오프라인/비정상 에이전트 수 확인',
    '□ Critical/High 알림 확인 및 처리',
    '□ 라이선스 만료 임박 항목 확인',
    '□ 디스크/스토리지 사용률 확인',
  ];

  checklist.forEach((item, i) => {
    slide.addText(item, {
      x: 0.5, y: 4.4 + i * 0.35, w: 9, h: 0.35,
      fontSize: 10, fontFace: 'Calibri', color: COLORS.text,
    });
  });
}

function addWeeklyMonthlySlide(pptx: PptxInstance) {
  const slide = pptx.addSlide();
  slide.addText('주간/월간 정기 절차', {
    x: 0.3, y: 0.2, w: 9.4, h: 0.5,
    fontSize: 18, fontFace: 'Calibri', color: COLORS.primary, bold: true,
  });

  const rows = [
    [
      { text: '주기', options: { bold: true, color: COLORS.white, fill: { color: COLORS.tableHeaderBg }, fontSize: 10 } },
      { text: '항목', options: { bold: true, color: COLORS.white, fill: { color: COLORS.tableHeaderBg }, fontSize: 10 } },
      { text: '상세 내용', options: { bold: true, color: COLORS.white, fill: { color: COLORS.tableHeaderBg }, fontSize: 10 } },
    ],
    ...([
      ['주간', '정기 점검', '에이전트 업데이트 현황, 정책 적용 상태, 로그 백업 확인'],
      ['주간', '알림 튜닝', '알림 규칙 정비, 오탐 줄이기, 새 규칙 추가 검토'],
      ['월간', '엔진 업데이트', '바이러스 엔진/DB 업데이트, 시그니처 버전 확인'],
      ['월간', '백업 검증', '설정 백업 파일 생성, 복원 테스트'],
      ['월간', '접근 권한 감사', '관리자 계정 목록 확인, 미사용 계정 정리'],
      ['분기', '보안 정책 리뷰', '전체 정책 재검토, 감사 대응 이력 정리'],
    ].map((row, i) => row.map(cell => ({
      text: cell,
      options: { fontSize: 9, fill: { color: i % 2 === 1 ? COLORS.tableRowAlt : COLORS.white } },
    })))),
  ];

  slide.addTable(rows, {
    x: 0.3, y: 0.8, w: 9.4, h: 3.5,
    fontSize: 9, fontFace: 'Calibri', color: COLORS.text,
    border: { type: 'solid', pt: 0.5, color: COLORS.tableBorder },
    colW: [1.2, 2.0, 6.2],
    autoPage: false,
  });
}

function addIncidentResponseSlide(pptx: PptxInstance) {
  const slide = pptx.addSlide();
  slide.addText('장애 대응 절차', {
    x: 0.3, y: 0.2, w: 9.4, h: 0.5,
    fontSize: 18, fontFace: 'Calibri', color: COLORS.primary, bold: true,
  });

  const phases = [
    ['감지', '알림 수신', 'Critical 알림 즉시 확인, 이메일/SMS 알림 체크'],
    ['분류', '심각도 분류', 'Critical / High / Medium / Low 분류 및 담당자 지정'],
    ['대응', '초기 대응', '에이전트 격리, 네트워크 차단, 로그 수집'],
    ['해결', '근본 원분 분석', '로그 분석, 원인 파악, 패치/설정 변경'],
    ['복구', '서비스 복구', '시스템 복원, 정상 동작 확인, 모니터링 강화'],
    ['사후', '보고 및 개선', '장애 보고서 작성, 대응 프로세스 개선'],
  ];

  phases.forEach((phase, i) => {
    const y = 0.9 + i * 0.85;
    const colors = [COLORS.red, COLORS.orange, 'FFC000', COLORS.green, COLORS.secondary, COLORS.primary];
    slide.addShape(pptx.ShapeType?.ROUNDED_RECTANGLE ?? pptx.shapes?.ROUNDED_RECTANGLE ?? 'roundRect', {
      x: 0.3, y, w: 1.0, h: 0.65,
      fill: { color: colors[i] },
      rectRadius: 0.08,
    });
    slide.addText(phase[0], {
      x: 0.3, y, w: 1.0, h: 0.65,
      fontSize: 11, fontFace: 'Calibri', color: COLORS.white, bold: true,
      align: 'center', valign: 'middle',
    });
    slide.addText(phase[1], {
      x: 1.5, y, w: 2.5, h: 0.35,
      fontSize: 11, fontFace: 'Calibri', color: COLORS.primary, bold: true,
    });
    slide.addText(phase[2], {
      x: 1.5, y: y + 0.3, w: 7.5, h: 0.35,
      fontSize: 9, fontFace: 'Calibri', color: COLORS.textLight,
    });

    // Arrow between phases
    if (i < phases.length - 1) {
      slide.addShape(pptx.ShapeType?.RIGHT_ARROW ?? pptx.shapes?.RIGHT_ARROW ?? 'rightArrow', {
        x: 0.55, y: y + 0.7, w: 0.5, h: 0.15,
        fill: { color: 'CCCCCC' },
      });
    }
  });
}

function addSecurityPolicySlide(pptx: PptxInstance) {
  const slide = pptx.addSlide();
  slide.addText('보안 정책 관리', {
    x: 0.3, y: 0.2, w: 9.4, h: 0.5,
    fontSize: 18, fontFace: 'Calibri', color: COLORS.primary, bold: true,
  });

  const rows = [
    [
      { text: '영역', options: { bold: true, color: COLORS.white, fill: { color: COLORS.tableHeaderBg }, fontSize: 10 } },
      { text: '정책 항목', options: { bold: true, color: COLORS.white, fill: { color: COLORS.tableHeaderBg }, fontSize: 10 } },
      { text: '설정 위치', options: { bold: true, color: COLORS.white, fill: { color: COLORS.tableHeaderBg }, fontSize: 10 } },
      { text: '운영 기준', options: { bold: true, color: COLORS.white, fill: { color: COLORS.tableHeaderBg }, fontSize: 10 } },
    ],
    ...([
      ['접근 제어', '관리자 계정 2FA', 'System > User Management', '전체 관리자 계정에 2FA 적용'],
      ['접근 제어', '最小 權限 原則', 'System > Role Management', '역할별 최소 권한 할당'],
      ['감사 로그', '감사 로그 보존', 'System > Log Settings', '최소 1년 이상 보존'],
      ['감사 로그', '로그 무결성', 'System > Log Forwarding', 'Syslog/SIEM으로 원격 전송'],
      ['정부 변경', '변경 관리', '전체 제품', '변경 전 승인, 변경 후 검증'],
      ['정부 변경', '백업 및 복원', 'System > Backup', '정기 백업 + 복원 테스트'],
    ].map((row, i) => row.map(cell => ({
      text: cell,
      options: { fontSize: 9, fill: { color: i % 2 === 1 ? COLORS.tableRowAlt : COLORS.white } },
    })))),
  ];

  slide.addTable(rows, {
    x: 0.3, y: 0.8, w: 9.4, h: 3.5,
    fontSize: 9, fontFace: 'Calibri', color: COLORS.text,
    border: { type: 'solid', pt: 0.5, color: COLORS.tableBorder },
    colW: [1.5, 2.2, 2.5, 3.2],
    autoPage: false,
  });
}

// ─── Main Exports ───────────────────────────────────────────────────────────

export async function buildSettingGuidePptx(options: PptxGuideOptions): Promise<PptxGuideResult> {
  const plan = options.plan ?? generateExcelBasedChangePlan({
    filePath: options.filePath,
    prioritizeOnly: true,
  });

  const consoleItems = plan.workPlan.filter(i => i.product !== 'external_or_manual');
  const manualItems = plan.workPlan.filter(i => i.product === 'external_or_manual');
  const byProduct = grouped(consoleItems);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pptx = new (PptxGenJS as any)();
  pptx.defineLayout({ name: 'CUSTOM', width: 10, height: 7.5 });
  pptx.layout = 'CUSTOM';
  pptx.author = 'Sangfor Engineer MCP';
  pptx.subject = 'Sangfor 제품 설정 가이드';

  // Title
  addTitleSlide(pptx, 'Sangfor 제품 설정 가이드', 'ITAC 감사 체크리스트 기반 Dry-run 가이드');

  // Summary
  addSummarySlide(pptx, plan);

  // Product slides
  for (const product of ['ENDPOINT_SECURE', 'IAG', 'NDR', 'HCI_SCP']) {
    const items = byProduct[product];
    if (items && items.length > 0) {
      addProductSlide(pptx, product, items, options.screenshotDir);
    }
  }

  // Manual evidence
  addManualEvidenceSlide(pptx, manualItems);

  // Dry-run procedure
  addDryRunSlide(pptx);

  // Customer checklist
  addCustomerChecklistSlide(pptx);

  // Output
  const outDir = options.outputPath
    ? dirname(options.outputPath)
    : join(process.cwd(), 'outputs');
  const pptxPath = options.outputPath ?? join(outDir, 'Sangfor_설정가이드_MCP.pptx');

  mkdirSync(dirname(pptxPath), { recursive: true });
  const buffer = await pptx.write({ outputType: 'nodebuffer' });
  writeFileSync(pptxPath, buffer);
  const size = existsSync(pptxPath) ? statSync(pptxPath).size : 0;

  return {
    pptxPath,
    size,
    slideCount: pptx.slides.length,
    planId: plan.id,
    totalItems: plan.workPlan.length,
    consoleItems: consoleItems.length,
    manualItems: manualItems.length,
    products: Object.keys(byProduct),
  };
}

export async function buildOperationsGuidePptx(options: PptxGuideOptions): Promise<PptxGuideResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pptx = new (PptxGenJS as any)();
  pptx.defineLayout({ name: 'CUSTOM', width: 10, height: 7.5 });
  pptx.layout = 'CUSTOM';
  pptx.author = 'Sangfor Engineer MCP';
  pptx.subject = 'Sangfor 제품 운영 가이드';

  // Title
  addOpsTitleSlide(pptx);

  // Daily monitoring
  addDailyMonitoringSlide(pptx);

  // Weekly/Monthly
  addWeeklyMonthlySlide(pptx);

  // Incident response
  addIncidentResponseSlide(pptx);

  // Security policy
  addSecurityPolicySlide(pptx);

  // Customer checklist (reuse)
  addCustomerChecklistSlide(pptx);

  // Output
  const outDir = options.outputPath
    ? dirname(options.outputPath)
    : join(process.cwd(), 'outputs');
  const pptxPath = options.outputPath ?? join(outDir, 'Sangfor_운영가이드_MCP.pptx');

  mkdirSync(dirname(pptxPath), { recursive: true });
  const buffer = await pptx.write({ outputType: 'nodebuffer' });
  writeFileSync(pptxPath, buffer);
  const size = existsSync(pptxPath) ? statSync(pptxPath).size : 0;

  return {
    pptxPath,
    size,
    slideCount: pptx.slides.length,
    planId: 'ops_guide',
    totalItems: 0,
    consoleItems: 0,
    manualItems: 0,
    products: ['ENDPOINT_SECURE', 'IAG', 'NDR', 'HCI_SCP'],
  };
}
