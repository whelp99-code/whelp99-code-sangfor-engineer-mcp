import { createHash } from 'node:crypto';
import type { ProductCode } from '@sangfor/shared';
import { PRODUCTS, containsSensitiveLearningTopic } from '@sangfor/shared';
import { isUsefulLearningText, type LearningSite } from './learning-sites.js';
import type {
  CrawlState,
  SiteCrawlStats,
  SiteLearningDocument,
} from './site-learning-types.js';

export function inferLearningProduct(text: string): ProductCode {
  const raw = text.trim();
  const normalized = raw.toLowerCase().replace(/[\s-]+/g, '_');
  const matches = new Set<ProductCode>();
  for (const product of PRODUCTS) {
    if (product.code === 'OTHER') continue;
    if (product.code.toLowerCase() === normalized) matches.add(product.code);
    if (product.aliases.some((alias) => {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\b${escaped}\\b`, 'i').test(raw);
    })) matches.add(product.code);
  }
  return matches.size === 1 ? [...matches][0] : 'OTHER';
}

export function normalizeLearningText(text: string): string {
  const paragraphs = text
    .replace(/\r/g, '')
    .split(/\n\s*\n|\n/)
    .map((value) => value.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const seen = new Set<string>();
  return paragraphs.filter((paragraph) => {
    const key = paragraph.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join('\n\n');
}

export function redactLearningSensitiveData(text: string): string {
  return text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
    .replace(/(?<!\w)(?:\+?\d(?:[\s()-]*\d){7,})(?!\w)/g, '[REDACTED_PHONE]')
    .replace(/(\bBearer\s+)[A-Za-z0-9._~-]{20,}/gi, '$1[REDACTED_TOKEN]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_TOKEN]');
}

export function isFineTuneEligibleLearningText(text: string): boolean {
  return !containsSensitiveLearningTopic(text);
}

export function prepareLearningTextForFineTune(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length >= 40 && isFineTuneEligibleLearningText(paragraph))
    .join('\n\n');
}

export function isDocumentFineTuneEligible(title: string, safeText: string): boolean {
  return safeText.length >= 180 && isFineTuneEligibleLearningText(title);
}

export function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 140);
}

export function documentMarkdown(document: SiteLearningDocument): string {
  return [
    '---',
    `id: ${document.id}`,
    `source: ${document.source}`,
    `sourceUrl: ${document.sourceUrl}`,
    `product: ${document.product}`,
    `trustLevel: ${document.trustLevel}`,
    `fetchedAt: ${document.fetchedAt}`,
    `contentHash: ${document.contentHash}`,
    '---',
    '',
    `# ${document.title}`,
    '',
    document.text,
  ].join('\n');
}

export function increment(values: Record<string, number>, key: string): void {
  values[key] = (values[key] ?? 0) + 1;
}

export function acceptDocument(
  state: CrawlState,
  site: LearningSite,
  candidate: Omit<SiteLearningDocument, 'siteId' | 'source' | 'trustLevel' | 'contentHash'>,
  stats: SiteCrawlStats,
): boolean {
  if (!isUsefulLearningText(candidate.text, candidate.title)) {
    increment(stats.rejected, 'low_quality_or_login_shell');
    return false;
  }
  const cleanText = redactLearningSensitiveData(normalizeLearningText(candidate.text));
  const hash = createHash('sha256').update(cleanText).digest('hex');
  if (state.seenHashes.has(hash)) {
    stats.duplicates += 1;
    return false;
  }
  state.seenHashes.add(hash);
  state.documents.push({
    ...candidate,
    text: cleanText,
    siteId: site.id,
    source: site.source,
    trustLevel: site.trustLevel,
    contentHash: hash,
  });
  stats.accepted += 1;
  const acceptedTotal = state.support.accepted + state.community.accepted;
  if (acceptedTotal % 25 === 0) state.persist?.();
  return true;
}
