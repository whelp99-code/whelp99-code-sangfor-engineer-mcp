/** Word .docx rendering of the advisory report (markdown → Word paragraphs, zipped). */

import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { renderAdvisoryReport } from './report-markdown.js';
import type { EvaluationResult, IntendedSpec } from './types.js';

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

  // zip runs from the temp workdir → need an absolute target. Confine to an output
  // root and reject path traversal BEFORE any destructive rmSync (no arbitrary overwrite)
  // and before any scratch directory exists, so a refusal leaves nothing behind.
  const outputRoot = resolve(process.env.SANGFOR_OUTPUT_ROOT ?? process.cwd());
  const absOut = resolve(outputRoot, outputPath);
  if (absOut !== outputRoot && !absOut.startsWith(outputRoot + sep)) {
    throw new Error(`docx outputPath escapes the output root: ${outputPath}`);
  }
  if (!absOut.toLowerCase().endsWith('.docx')) throw new Error('docx outputPath must end with .docx');

  const work = join(tmpdir(), `advdocx-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  try {
    mkdirSync(join(work, 'word'), { recursive: true });
    mkdirSync(join(work, '_rels'), { recursive: true });
    writeFileSync(join(work, '[Content_Types].xml'), contentTypes);
    writeFileSync(join(work, '_rels', '.rels'), rels);
    writeFileSync(join(work, 'word', 'document.xml'), documentXml);
    mkdirSync(dirname(absOut), { recursive: true });
    try { rmSync(absOut, { force: true }); } catch {}
    execFileSync('zip', ['-qr', absOut, '.'], { cwd: work });
    return { docxPath: outputPath, size: statSync(absOut).size };
  } finally {
    // Success, a failed part write, a bad destination, and a failed zip all drop the
    // scratch root; the two refusals above return before it is ever created.
    rmSync(work, { recursive: true, force: true });
  }
}
