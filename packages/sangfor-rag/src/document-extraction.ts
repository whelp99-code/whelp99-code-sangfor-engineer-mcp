import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

const require = createRequire(import.meta.url);

export async function extractTextFromFile(filePath: string): Promise<string> {
  const extension = extname(filePath).toLowerCase();
  if (extension === '.pdf') return extractTextFromPdf(filePath);
  if (['.md', '.markdown', '.txt', '.html', '.htm'].includes(extension)) return readFileSync(filePath, 'utf8');
  if (extension === '.docx') return extractTextFromDocx(filePath);
  if (extension === '.pptx') return extractTextFromPptx(filePath);
  if (['.xlsx', '.xlsm'].includes(extension)) return extractTextFromXlsx(filePath);
  throw new Error(`Unsupported document type for ingestion: ${extension}`);
}

function unzipList(filePath: string): string[] {
  return execFileSync('unzip', ['-Z1', filePath], { encoding: 'utf8' })
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function unzipText(filePath: string, entry: string): string {
  return execFileSync('unzip', ['-p', filePath, entry], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function xmlToText(xml: string): string {
  return decodeXmlEntities(
    xml
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:w:p|a:p|p|row|si|table:table-row)>/gi, '\n')
      .replace(/<\/(?:w:tc|a:t|t|c)>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sortedOfficeEntries(entries: readonly string[], pattern: RegExp): string[] {
  return entries
    .filter((entry) => pattern.test(entry))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

export async function extractTextFromDocx(filePath: string): Promise<string> {
  const entries = sortedOfficeEntries(
    unzipList(filePath),
    /^word\/(?:document|footnotes|endnotes|header\d+|footer\d+)\.xml$/i,
  );
  const text = entries.map((entry) => xmlToText(unzipText(filePath, entry))).filter(Boolean).join('\n\n');
  if (!text) throw new Error(`DOCX text extraction produced no text: ${filePath}`);
  return text;
}

export async function extractTextFromPptx(filePath: string): Promise<string> {
  const entries = sortedOfficeEntries(unzipList(filePath), /^ppt\/slides\/slide\d+\.xml$/i);
  const text = entries
    .map((entry, index) => {
      const slideText = xmlToText(unzipText(filePath, entry));
      return slideText ? `Slide ${index + 1}\n${slideText}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
  if (!text) throw new Error(`PPTX text extraction produced no text: ${filePath}`);
  return text;
}

export async function extractTextFromXlsx(filePath: string): Promise<string> {
  const entries = sortedOfficeEntries(
    unzipList(filePath),
    /^xl\/(?:sharedStrings|workbook|worksheets\/sheet\d+)\.xml$/i,
  );
  const text = entries.map((entry) => xmlToText(unzipText(filePath, entry))).filter(Boolean).join('\n\n');
  if (!text) throw new Error(`XLSX text extraction produced no text: ${filePath}`);
  return text;
}

export async function extractTextFromPdf(filePath: string): Promise<string> {
  try {
    const pdfParse: unknown = require('pdf-parse');
    if (typeof pdfParse === 'function') {
      const result: unknown = await pdfParse(readFileSync(filePath));
      if (typeof result === 'object' && result !== null && 'text' in result
        && typeof result.text === 'string' && result.text.trim()) return result.text;
    }
  } catch (error) {
    if (error instanceof Error) {
      // Any pdf-parse Error selects the established pdftotext fallback.
    }
  }
  try {
    return execFileSync('pdftotext', [filePath, '-'], { encoding: 'utf8' });
  } catch {
    const raw = readFileSync(filePath).toString('latin1');
    const rough = raw.replace(/[^\x09\x0a\x0d\x20-\x7E가-힣]/g, ' ');
    if (rough.trim().length < 100) {
      throw new Error('PDF text extraction failed. Install pdf-parse dependency or poppler pdftotext.');
    }
    return rough;
  }
}

export function chunkText(
  text: string,
  options: { readonly maxChars?: number; readonly overlapChars?: number } = {},
): string[] {
  const maxChars = options.maxChars ?? 1400;
  const overlapChars = options.overlapChars ?? 180;
  const normalized = text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    const end = Math.min(start + maxChars, normalized.length);
    let cut = end;
    const paragraphCut = normalized.lastIndexOf('\n\n', end);
    if (paragraphCut > start + Math.floor(maxChars * 0.55)) cut = paragraphCut;
    chunks.push(normalized.slice(start, cut).trim());
    if (cut >= normalized.length) break;
    start = Math.max(0, cut - overlapChars);
  }
  return chunks.filter(Boolean);
}
