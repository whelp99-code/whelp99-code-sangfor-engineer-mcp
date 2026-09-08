import { nowId } from '@sangfor/shared';
import { readXlsxWorkbook } from './xlsx-reader.js';
import type { ExcelImportResult, ExcelRequirementRow } from './types.js';

const DEFAULT_EVIDENCE_NEEDS = ['current setting screenshot', 'audit/checklist row reference', 'before/after comparison candidate'];

interface ExcelRowNormalizeInput {
  rowNumber: number;
  no?: string;
  category?: string;
  solution?: string;
  item?: string;
  specificDetails?: string;
  inspectionResult: Record<string, string>;
  resultScore?: number;
  resultRaw?: string;
  reason?: string;
  assessmentCriteria?: string;
  remark?: string;
}

export function importExcelRequirementList(input: { filePath: string; sheetName?: string; prioritizeOnly?: boolean }): ExcelImportResult {
  const workbook = readXlsxWorkbook(input.filePath);
  const sheet = input.sheetName
    ? workbook.sheets.find(candidate => candidate.name === input.sheetName)
    : workbook.sheets[0];
  if (!sheet) throw new Error(`Excel sheet not found: ${input.sheetName ?? '<first sheet>'}`);

  const headerRow = findChecklistHeaderRow(sheet.rows);
  if (!headerRow) throw new Error('Checklist header row not found. Expected columns such as No, Category, Soultion/Solution, Item, Specific details.');
  const header = mergeHeaderRows(sheet.rows.get(headerRow - 1) ?? {}, sheet.rows.get(headerRow) ?? {});
  const rows: ExcelRequirementRow[] = [];
  for (const [rowNumber, cells] of [...sheet.rows.entries()].sort(([a], [b]) => a - b)) {
    if (rowNumber <= headerRow) continue;
    const no = cellByHeader(cells, header, ['No']);
    const category = cellByHeader(cells, header, ['Category']);
    const solution = cellByHeader(cells, header, ['Soultion', 'Solution']);
    const item = cellByHeader(cells, header, ['Item']);
    const specificDetails = cellByHeader(cells, header, ['Specific details', 'Specific detail']);
    const reason = cellByHeader(cells, header, ['Reason for Inspection Results', 'Reason']);
    const assessmentCriteria = cellByHeader(cells, header, ['Assessment Criteria']) ?? cells.N;
    const remark = cellByHeader(cells, header, ['Remark']) ?? cells.O;
    const resultRaw = cellByHeader(cells, header, ['Results']);
    if (![no, category, solution, item, specificDetails, reason, assessmentCriteria, remark].some(Boolean)) continue;
    const inspectionResult = inspectionResultsFromRow(cells, header);
    const resultScore = parseOptionalNumber(resultRaw);
    const row = normalizeExcelRow({
      rowNumber,
      no,
      category,
      solution,
      item,
      specificDetails,
      inspectionResult,
      resultScore,
      resultRaw,
      reason,
      assessmentCriteria,
      remark
    });
    if (!input.prioritizeOnly || row.priority !== 'low') rows.push(row);
  }
  return {
    id: nowId('excel_import'),
    filePath: input.filePath,
    sheetName: sheet.name,
    headerRow,
    rows,
    summary: {
      totalRows: rows.length,
      prioritizedRows: rows.filter(row => row.priority !== 'low').length,
      highPriorityRows: rows.filter(row => row.priority === 'high').length
    }
  };
}

function findChecklistHeaderRow(rows: Map<number, Record<string, string>>): number | undefined {
  for (const [rowNumber, row] of rows) {
    const values = Object.values(row).map(value => normalizeHeader(value));
    if (values.includes('no') && values.includes('category') && values.includes('item') && values.includes('specificdetails')) {
      return rowNumber;
    }
  }
  return undefined;
}

function mergeHeaderRows(parentHeader: Record<string, string>, header: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const column of unique([...Object.keys(parentHeader), ...Object.keys(header)])) {
    merged[column] = header[column] || parentHeader[column] || '';
  }
  return merged;
}

function cellByHeader(cells: Record<string, string>, header: Record<string, string>, names: string[]): string | undefined {
  const wanted = names.map(normalizeHeader);
  const column = Object.entries(header).find(([, value]) => wanted.includes(normalizeHeader(value)))?.[0];
  const value = column ? cells[column] : undefined;
  return value || undefined;
}

function inspectionResultsFromRow(cells: Record<string, string>, header: Record<string, string>): Record<string, string> {
  const ignored = new Set(['no', 'category', 'soultion', 'solution', 'item', 'specificdetails', 'results', 'reasonforinspectionresults', 'assessmentcriteria', 'remark']);
  const result: Record<string, string> = {};
  for (const [column, headerValue] of Object.entries(header)) {
    const normalized = normalizeHeader(headerValue);
    if (!headerValue || ignored.has(normalized)) continue;
    const value = cells[column];
    if (value) result[headerValue] = value;
  }
  return result;
}

function normalizeExcelRow(input: ExcelRowNormalizeInput): ExcelRequirementRow {
  const inspectionValues = Object.values(input.inspectionResult);
  const isPartial = inspectionValues.some(value => value.includes('△'));
  const hasGap = Boolean(input.reason?.trim());
  const lowScore = typeof input.resultScore === 'number' && input.resultScore < 1;
  const priority: ExcelRequirementRow['priority'] = isPartial || lowScore
    ? 'high'
    : hasGap
      ? 'medium'
      : 'low';
  const requirement = [input.solution, input.item, input.specificDetails].filter(Boolean).join(' | ');
  const currentGap = input.reason || (isPartial ? `Inspection result includes partial status: ${inspectionValues.join(', ')}` : '');
  const targetControl = input.assessmentCriteria || input.specificDetails || requirement;
  return {
    rowNumber: input.rowNumber,
    rowId: `excel_row_${input.rowNumber}`,
    no: input.no,
    category: input.category,
    solution: input.solution,
    item: input.item,
    specificDetails: input.specificDetails,
    inspectionResult: input.inspectionResult,
    resultScore: input.resultScore,
    resultRaw: input.resultRaw,
    reason: input.reason,
    assessmentCriteria: input.assessmentCriteria,
    remark: input.remark,
    requirement,
    evidenceNeed: evidenceNeedsForText(`${requirement} ${targetControl}`),
    targetControl,
    currentGap,
    priority
  };
}

function evidenceNeedsForText(text: string): string[] {
  const value = text.toLowerCase();
  const needs = [...DEFAULT_EVIDENCE_NEEDS];
  if (hasAny(value, ['log', 'event'])) needs.push('log retention/export evidence');
  if (hasAny(value, ['agent', 'endpoint', 'edr', 'antivirus'])) needs.push('endpoint agent inventory and update status');
  if (hasAny(value, ['policy', 'url', 'application', 'auth'])) needs.push('policy/auth configuration screenshot');
  if (hasAny(value, ['incident', 'alert', 'soar'])) needs.push('incident/alert/playbook evidence');
  return unique(needs);
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9가-힣]+/g, '');
}

function parseOptionalNumber(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function hasAny(value: string, terms: string[]): boolean {
  return terms.some(term => value.includes(term));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
