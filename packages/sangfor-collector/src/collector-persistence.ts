import { createHash } from 'node:crypto';
import type { CollectedDocument } from './collector-types.js';

export function sanitizeForFineTune(text: string): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b\+?\d[\d\s()-]{8,}\d\b/g, '[phone]')
    .replace(/\b(?:password|passwd|api[_-]?key|secret|token)\s*[:=]\s*\S+/gi, '[redacted]')
    .replace(/password/gi, 'credential')
    .replace(/\botp\b/gi, 'one-time-code')
    .replace(/\bmfa\b/gi, 'multi-factor-auth')
    .replace(/\blicense key\b/gi, 'license-reference');
}

export function docsToFineTuneExamples(docs: CollectedDocument[]): Array<{
  input: string;
  expectedOutput: string;
  source: string;
}> {
  return docs.map((document) => ({
    input: `[${document.product}] Summarize key engineering guidance from: ${document.title}`,
    expectedOutput: sanitizeForFineTune(document.text).slice(0, 1200),
    source: document.sourceUrl,
  }));
}

export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
