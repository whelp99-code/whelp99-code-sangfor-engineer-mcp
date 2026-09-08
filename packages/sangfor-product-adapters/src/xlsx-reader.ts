import { execFileSync } from 'node:child_process';

interface ParsedSheet {
  name: string;
  rows: Map<number, Record<string, string>>;
}

interface ParsedWorkbook {
  sheets: ParsedSheet[];
}

export function readXlsxWorkbook(filePath: string): ParsedWorkbook {
  if (!filePath.toLowerCase().endsWith('.xlsx')) throw new Error(`Expected .xlsx file: ${filePath}`);
  const entries = unzipList(filePath);
  const sharedStrings = entries.includes('xl/sharedStrings.xml') ? parseSharedStrings(unzipText(filePath, 'xl/sharedStrings.xml')) : [];
  const relationships = parseWorkbookRelationships(unzipText(filePath, 'xl/_rels/workbook.xml.rels'));
  const sheets = parseWorkbookSheets(unzipText(filePath, 'xl/workbook.xml'), relationships)
    .map(sheet => ({
      name: sheet.name,
      rows: parseWorksheetRows(unzipText(filePath, sheet.path), sharedStrings)
    }));
  return { sheets };
}

function unzipList(filePath: string): string[] {
  return execFileSync('unzip', ['-Z1', filePath], { encoding: 'utf8' })
    .split(/\r?\n/)
    .map(entry => entry.trim())
    .filter(Boolean);
}

function unzipText(filePath: string, entry: string): string {
  return execFileSync('unzip', ['-p', filePath, entry], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function parseSharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)]
    .map(match => xmlText(match[1]));
}

function parseWorkbookRelationships(xml: string): Record<string, string> {
  const relationships: Record<string, string> = {};
  for (const match of xml.matchAll(/<Relationship\b([^>]*)\/>/g)) {
    const id = attr(match[1], 'Id');
    const target = attr(match[1], 'Target');
    if (id && target) relationships[id] = target.startsWith('xl/') ? target : `xl/${target.replace(/^\//, '')}`;
  }
  return relationships;
}

function parseWorkbookSheets(xml: string, relationships: Record<string, string>): Array<{ name: string; path: string }> {
  return [...xml.matchAll(/<sheet\b([^>]*)\/>/g)]
    .map(match => {
      const name = attr(match[1], 'name') ?? 'Sheet';
      const relationshipId = attr(match[1], 'r:id');
      const path = relationshipId ? relationships[relationshipId] : undefined;
      if (!path) throw new Error(`Workbook sheet relationship not found: ${name}`);
      return { name, path };
    });
}

function parseWorksheetRows(xml: string, sharedStrings: string[]): Map<number, Record<string, string>> {
  const rows = new Map<number, Record<string, string>>();
  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowNumber = Number(attr(rowMatch[1], 'r'));
    if (!Number.isFinite(rowNumber)) continue;
    const row: Record<string, string> = {};
    for (const cellMatch of parseCells(rowMatch[2])) {
      const ref = attr(cellMatch.attrs, 'r');
      if (!ref) continue;
      const column = ref.match(/[A-Z]+/)?.[0];
      if (!column) continue;
      const type = attr(cellMatch.attrs, 't');
      const raw = cellMatch.body;
      const valueMatch = raw.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
      let value = valueMatch ? decodeXml(valueMatch[1]) : xmlText(raw);
      if (type === 's' && value !== '') value = sharedStrings[Number(value)] ?? value;
      row[column] = normalizeWhitespace(value);
    }
    rows.set(rowNumber, row);
  }
  return rows;
}

function parseCells(rowXml: string): Array<{ attrs: string; body: string }> {
  const cells: Array<{ attrs: string; body: string }> = [];
  const cellRegex = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  for (const match of rowXml.matchAll(cellRegex)) {
    cells.push({ attrs: match[1], body: match[2] ?? '' });
  }
  return cells;
}

function attr(xmlAttrs: string, name: string): string | undefined {
  const escapedName = name.replace(':', String.raw`\:`);
  const match = xmlAttrs.match(new RegExp(`\\b${escapedName}="([^"]*)"`));
  return match ? decodeXml(match[1]) : undefined;
}

function xmlText(xml: string): string {
  return normalizeWhitespace(decodeXml(xml.replace(/<[^>]+>/g, ' ')));
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').trim();
}
