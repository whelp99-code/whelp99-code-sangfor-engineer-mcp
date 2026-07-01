/**
 * @sangfor/spec — IntendedSpec: the single data contract shared by the advisory
 * services (guide / verify / diagnose). A spec declares what a correct config
 * looks like; evaluateSpec() compares it to an observed config and produces
 * PASS / FAIL / INDETERMINATE verdicts.
 *
 * Safety principle (fixes the verifier false-pass class of bug):
 *   INDETERMINATE is NEVER counted as PASS, and overall `ok` requires positive
 *   evidence (at least one PASS, zero FAIL, zero INDETERMINATE).
 */

import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolveRepoData } from '../../shared/src/index.js';

export type CompareOp = 'eq' | 'neq' | 'gte' | 'lte' | 'includes' | 'oneOf' | 'exists';
export type Severity = 'must' | 'recommended';
export type Verdict = 'PASS' | 'FAIL' | 'INDETERMINATE';
export type Category = 'ok' | 'misconfiguration' | 'missing' | 'indeterminate';

export interface Citation {
  manual: string;
  section?: string;
  page?: string;
}

export interface SpecItem {
  id: string;
  capabilityId: string;
  label: string;
  observedKey: string;
  op: CompareOp;
  expected?: unknown;
  severity: Severity;
  source?: Citation;
  needsSeniorReview?: boolean;
}

export interface IntendedSpec {
  id: string;
  product: string;
  version?: string;
  items: SpecItem[];
}

export interface ItemResult {
  id: string;
  label: string;
  verdict: Verdict;
  category: Category;
  observed?: unknown;
  expected?: unknown;
  reason: string;
}

export interface EvaluationSummary {
  pass: number;
  fail: number;
  indeterminate: number;
  misconfiguration: number;
  missing: number;
}

export interface EvaluationResult {
  specId: string;
  ok: boolean;
  items: ItemResult[];
  summary: EvaluationSummary;
}

const SPEC_ROOT = resolveRepoData('data/specs', 'SANGFOR_SPEC_ROOT');

/** Map product aliases to the canonical product code used across planner/adapters/spec joins. */
export function normalizeSpecProduct(input: string): string {
  const s = input.trim().toLowerCase();
  if (/\b(swg|iag|internet access|secure web)\b/.test(s)) return 'IAG';
  if (/\b(epp|endpoint|athena ep|asec)\b/.test(s)) return 'ENDPOINT_SECURE';
  if (/\b(cc|cyber command)\b/.test(s)) return 'CYBER_COMMAND';
  if (/\b(ndr)\b/.test(s)) return 'NDR';
  if (/\b(xdr)\b/.test(s)) return 'XDR';
  if (/\b(ngfw|firewall)\b/.test(s)) return 'NGFW';
  if (/\b(scp|hci\/scp|hci scp|sangfor cloud platform)\b/.test(s)) return 'HCI_SCP';
  if (/\b(hci|asv)\b/.test(s)) return 'HCI';
  return input.trim().toUpperCase();
}

function specDirectoryCandidates(product: string): string[] {
  const canonical = normalizeSpecProduct(product);
  const legacy: Record<string, string[]> = {
    ENDPOINT_SECURE: ['EPP'],
    CYBER_COMMAND: ['CC'],
    HCI_SCP: ['HCI', 'SCP'],
    IAG: ['SWG'],
  };
  return [canonical, ...(legacy[canonical] ?? [])];
}

/** Load and merge all spec JSON files for a product/version, or null if none. */
export function loadSpec(product: string, version: string, root: string = SPEC_ROOT): IntendedSpec | null {
  const productDir = specDirectoryCandidates(product).find((candidate) => existsSync(join(root, candidate, version)));
  if (!productDir) return null;
  const dir = join(root, productDir, version);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
  if (files.length === 0) return null;
  const items: SpecItem[] = [];
  let product0 = normalizeSpecProduct(product);
  for (const f of files) {
    const parsed = JSON.parse(readFileSync(join(dir, f), 'utf8')) as IntendedSpec;
    if (parsed.product) product0 = normalizeSpecProduct(parsed.product);
    items.push(...(parsed.items ?? []));
  }
  return { id: `spec_${normalizeSpecProduct(product)}_${version}`.replace(/[^\w]/g, '_'), product: product0, version, items };
}

/** List all product/version pairs that have specs on disk. */
export function listSpecCoverage(root: string = SPEC_ROOT): Array<{ product: string; version: string; items: number }> {
  const out: Array<{ product: string; version: string; items: number }> = [];
  if (!existsSync(root)) return out;
  for (const product of readdirSync(root)) {
    const pDir = join(root, product);
    if (!statSync(pDir).isDirectory()) continue;
    for (const version of readdirSync(pDir)) {
      const vDir = join(pDir, version);
      if (!statSync(vDir).isDirectory()) continue;
      const spec = loadSpec(product, version, root);
      if (spec) out.push({ product, version, items: spec.items.length });
    }
  }
  return out;
}

export function evaluateSpec(spec: IntendedSpec, observed: Record<string, unknown>): EvaluationResult {
  const items: ItemResult[] = spec.items.map((item) => {
    const base = { id: item.id, label: item.label, expected: item.expected };

    // Cannot assert a MUST item without a source citation — needs senior review.
    if (item.severity === 'must' && !item.source) {
      return { ...base, verdict: 'INDETERMINATE', category: 'indeterminate',
        reason: 'MUST item has no source citation — needs senior review before asserting misconfiguration' };
    }

    // No observed value → cannot determine.
    if (!Object.prototype.hasOwnProperty.call(observed, item.observedKey)) {
      return { ...base, verdict: 'INDETERMINATE', category: 'indeterminate',
        reason: `No observed value for "${item.observedKey}"` };
    }

    const value = observed[item.observedKey];
    const cmp = compareValue(item.op, value, item.expected);
    if (cmp === 'indeterminate') {
      // Observed type/shape is incompatible with the expected type (e.g. scraped
      // string 'true' vs boolean true, 'N/A' vs a numeric threshold). Comparing
      // anyway would fabricate a PASS or FAIL — surface it as 판정 불가 instead.
      return { ...base, verdict: 'INDETERMINATE', category: 'indeterminate', observed: value,
        reason: `관측 타입(${typeof value})이 기대 타입과 불일치하거나 수치 변환 불가 — 판정 불가` };
    }
    if (cmp === 'pass') {
      // A datum flagged for senior review must never be auto-PASSed, even on a match.
      if (item.needsSeniorReview) {
        return { ...base, verdict: 'INDETERMINATE', category: 'indeterminate', observed: value,
          reason: '시니어 검토 필요 항목 — 자동 PASS 금지 (senior review required)' };
      }
      return { ...base, verdict: 'PASS', category: 'ok', observed: value, reason: 'matches expected' };
    }
    const category: Category = item.severity === 'must' ? 'misconfiguration' : 'missing';
    const seniorNote = item.needsSeniorReview ? ' — 시니어 검토 필요(senior review)' : '';
    return { ...base, verdict: 'FAIL', category, observed: value,
      reason: `expected ${item.op} ${JSON.stringify(item.expected)}, observed ${JSON.stringify(value)}${seniorNote}` };
  });

  const summary = summarize(items);
  return { specId: spec.id, ok: computeOk(summary), items, summary };
}

/** Render a Korean advisory report separating 잘못된 설정 / 추가 필요 / 판정 불가 / 정상. */
export function renderAdvisoryReport(spec: IntendedSpec, result: EvaluationResult): string {
  const byCat = (c: Category) => result.items.filter((i) => i.category === c);
  const cite = (id: string) => {
    const item = spec.items.find((s) => s.id === id);
    const src = item?.source;
    return src ? ` \n  - 근거: ${src.manual}${src.section ? ` — ${src.section}` : ''}${src.page ? `\n  - 출처: ${src.page}` : ''}` : ' \n  - 근거: (출처 없음 — 시니어 검토 필요)';
  };
  const line = (i: ItemResult) => {
    const ev = i.observed !== undefined ? ` (기대: ${JSON.stringify(i.expected)}, 실제: ${JSON.stringify(i.observed)})` : (i.expected !== undefined ? ` (기대: ${JSON.stringify(i.expected)}, 실제: 확인 불가)` : '');
    const senior = spec.items.find((s) => s.id === i.id)?.needsSeniorReview ? ' ⚠ 시니어 검토 필요' : '';
    return `- **${i.label}**${senior}${ev}${cite(i.id)}`;
  };
  const section = (title: string, cat: Category, empty: string) => {
    const items = byCat(cat);
    return `## ${title} (${items.length})\n\n${items.length ? items.map(line).join('\n\n') : `_${empty}_`}\n`;
  };

  const s = result.summary;
  return [
    `# Sangfor 설정 자문 리포트 — ${spec.product} ${spec.version ?? ''}`.trim(),
    ``,
    `> ⚠️ **면책**: 본 리포트는 AI가 수집된 제품 매뉴얼을 근거로 생성한 **참고용 자문**입니다. 최종 판단과 적용은 담당 엔지니어의 책임입니다. AI는 어떤 장비 설정도 변경하지 않았습니다(read-only).`,
    ``,
    `- 대상 제품/버전: **${spec.product} ${spec.version ?? ''}**`,
    `- 요약: 잘못됨 ${s.misconfiguration} · 추가 필요 ${s.missing} · 판정 불가 ${s.indeterminate} · 정상 ${s.pass}`,
    `- 종합 판정(ok): **${result.ok ? '정상' : '조치 필요'}**`,
    ``,
    section('잘못된 설정 (misconfiguration)', 'misconfiguration', '없음'),
    section('추가로 필요 (missing/recommended)', 'missing', '없음'),
    section('판정 불가 (indeterminate — 설정값 미확인/근거 부족)', 'indeterminate', '없음'),
    section('정상 (ok)', 'ok', '없음'),
    `---`,
    ``,
    `## 사람 최종 확인 (sign-off)`,
    ``,
    `- [ ] 위 잘못된 설정 항목을 담당 엔지니어가 검토하고 조치 여부를 결정함`,
    `- [ ] 판정 불가 항목의 실제 설정값을 사람이 직접 확인함`,
    `- 담당 엔지니어: ____________  일자: __________`,
    ``,
  ].join('\n');
}

/** Render the advisory report as a Word .docx (markdown → Word paragraphs, zipped). */
export function renderAdvisoryReportDocx(spec: IntendedSpec, result: EvaluationResult, outputPath: string): { docxPath: string; size: number } {
  const md = renderAdvisoryReport(spec, result);
  const esc = (s: string) => s
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '') // strip XML-1.0-illegal control chars
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const para = (text: string, opts: { style?: string; bold?: boolean; size?: number; color?: string } = {}) => {
    const rpr = `<w:rPr>${opts.bold ? '<w:b/>' : ''}${opts.size ? `<w:sz w:val="${opts.size}"/>` : ''}${opts.color ? `<w:color w:val="${opts.color}"/>` : ''}</w:rPr>`;
    const ppr = opts.style ? `<w:pPr><w:pStyle w:val="${opts.style}"/></w:pPr>` : '';
    return `<w:p>${ppr}<w:r>${rpr}<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
  };
  const body = md.split('\n').map((line) => {
    if (line.startsWith('# ')) return para(line.slice(2), { bold: true, size: 36, color: '0B2545' });
    if (line.startsWith('## ')) return para(line.slice(3), { bold: true, size: 28, color: '2E74B5' });
    if (line.startsWith('> ')) return para(line.slice(2).replace(/\*\*/g, ''), { size: 20, color: '888888' });
    if (line.startsWith('- ')) return para('• ' + line.slice(2).replace(/\*\*/g, ''), { size: 22 });
    if (line.startsWith('  - ')) return para('    ' + line.slice(4), { size: 20, color: '555555' });
    if (line.trim() === '---') return para('────────────────────', { color: 'CCCCCC' });
    if (!line.trim()) return '<w:p/>';
    return para(line.replace(/\*\*/g, ''), { size: 22 });
  }).join('');

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

  const work = join(tmpdir(), `advdocx-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(join(work, 'word'), { recursive: true });
  mkdirSync(join(work, '_rels'), { recursive: true });
  writeFileSync(join(work, '[Content_Types].xml'), contentTypes);
  writeFileSync(join(work, '_rels', '.rels'), rels);
  writeFileSync(join(work, 'word', 'document.xml'), documentXml);
  // zip runs from the temp workdir → need an absolute target. Confine to an output
  // root and reject path traversal BEFORE any destructive rmSync (no arbitrary overwrite).
  const outputRoot = resolve(process.env.SANGFOR_OUTPUT_ROOT ?? process.cwd());
  const absOut = resolve(outputRoot, outputPath);
  if (absOut !== outputRoot && !absOut.startsWith(outputRoot + sep)) {
    throw new Error(`docx outputPath escapes the output root: ${outputPath}`);
  }
  if (!absOut.toLowerCase().endsWith('.docx')) throw new Error('docx outputPath must end with .docx');
  mkdirSync(dirname(absOut), { recursive: true });
  try { rmSync(absOut, { force: true }); } catch {}
  execFileSync('zip', ['-qr', absOut, '.'], { cwd: work });
  rmSync(work, { recursive: true, force: true });
  return { docxPath: outputPath, size: statSync(absOut).size };
}

type CompareOutcome = 'pass' | 'fail' | 'indeterminate';

const isScalar = (v: unknown): boolean =>
  v === null || v === undefined || ['string', 'number', 'boolean'].includes(typeof v);

/** Parse a value to a finite number, or null if it cannot be trusted as numeric. */
function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null; // boolean / object / null / undefined are not trustworthy numbers
}

/**
 * Compare an observed value to the spec's expected value. Returns a THREE-state
 * outcome: a type/shape mismatch yields 'indeterminate' rather than silently
 * coercing into a fabricated 'pass'/'fail' (INDETERMINATE ≠ PASS principle).
 */
function compareValue(op: CompareOp, observed: unknown, expected: unknown): CompareOutcome {
  switch (op) {
    case 'eq':
    case 'neq': {
      // If both are scalars of different primitive type (e.g. boolean true vs
      // scraped string 'true'), the comparison is untrustworthy → indeterminate.
      if (isScalar(observed) && isScalar(expected) && observed != null && expected != null
        && typeof observed !== typeof expected) {
        return 'indeterminate';
      }
      const equal = observed === expected;
      return (op === 'eq' ? equal : !equal) ? 'pass' : 'fail';
    }
    case 'gte':
    case 'lte': {
      const a = toFiniteNumber(observed);
      const b = toFiniteNumber(expected);
      if (a === null || b === null) return 'indeterminate';
      return (op === 'gte' ? a >= b : a <= b) ? 'pass' : 'fail';
    }
    case 'includes': {
      if (Array.isArray(observed)) return observed.includes(expected) ? 'pass' : 'fail';
      if (typeof observed === 'string' && (typeof expected === 'string' || typeof expected === 'number')) {
        return observed.includes(String(expected)) ? 'pass' : 'fail';
      }
      return 'indeterminate';
    }
    case 'oneOf':
      if (!Array.isArray(expected)) return 'indeterminate';
      return expected.includes(observed) ? 'pass' : 'fail';
    case 'exists':
      return observed !== undefined && observed !== null && observed !== '' ? 'pass' : 'fail';
    default:
      return 'indeterminate';
  }
}

function summarize(items: ItemResult[]): EvaluationSummary {
  return {
    pass: items.filter((i) => i.verdict === 'PASS').length,
    fail: items.filter((i) => i.verdict === 'FAIL').length,
    indeterminate: items.filter((i) => i.verdict === 'INDETERMINATE').length,
    misconfiguration: items.filter((i) => i.category === 'misconfiguration').length,
    missing: items.filter((i) => i.category === 'missing').length,
  };
}

function computeOk(s: EvaluationSummary): boolean {
  // positive evidence required; no failures; nothing undetermined
  return s.pass > 0 && s.fail === 0 && s.indeterminate === 0;
}
