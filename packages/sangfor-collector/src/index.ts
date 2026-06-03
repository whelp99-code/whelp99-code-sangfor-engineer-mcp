import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProductCode } from '@sangfor/shared';
import { normalizeProduct } from '@sangfor/shared';

export type SourceKind = 'knowledge' | 'community' | 'knowledge_catalog';

export interface CollectedDocument {
  id: string;
  source: SourceKind;
  sourceUrl: string;
  product: ProductCode;
  title: string;
  text: string;
  trustLevel: 'official' | 'internal';
  fetchedAt: string;
}

export interface CollectOptions {
  communityMaxThreadsPerForum?: number;
  knowledgeMaxArticles?: number;
  kbToken?: string;
  kbBaseUrl?: string;
  communityBaseUrl?: string;
  rawDir?: string;
  forumIds?: number[];
}

const DEFAULT_FORUM_IDS = [156, 157, 158, 167, 89, 92, 137, 138];
const USER_AGENT = 'sangfor-engineer-mcp/0.1 (learning-pipeline; +https://github.com/whelp99-code/whelp99-code-sangfor-engineer-mcp)';

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export async function fetchText(url: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/json,*/*', ...headers }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

export function inferProductFromText(text: string, fallback: ProductCode = 'HCI'): ProductCode {
  const lower = text.toLowerCase();
  if (/\b(iag|swg|internet access gateway)\b/.test(lower)) return 'IAG';
  if (/\b(endpoint secure|epp|edr|aSec)\b/.test(lower)) return 'ENDPOINT_SECURE';
  if (/\b(cyber command|ngfw|ndr|xdr|mdr|soc)\b/.test(lower)) return 'CYBER_COMMAND';
  if (/\b(hci|hyper.?converged|aSV|vmware)\b/.test(lower)) return 'HCI';
  return normalizeProduct(text) !== 'HCI' || /\bhci\b/i.test(text) ? normalizeProduct(text) : fallback;
}

export function isCommunityNoise(title: string): boolean {
  const t = title.toLowerCase();
  return /honor award|daily q&a challenge|get coins|verify your account|rules and punishment|company profile/i.test(t);
}

export function parseCommunityThreadIds(html: string): number[] {
  const ids = new Set<number>();
  for (const m of html.matchAll(/mod=viewthread&amp;tid=(\d+)|mod=viewthread&tid=(\d+)/g)) {
    ids.add(Number(m[1] ?? m[2]));
  }
  return [...ids];
}

export function parseCommunityThread(html: string, tid: number, sourceUrl: string): CollectedDocument | null {
  const titleMatch = html.match(/<span id="thread_subject">([^<]+)<\/span>/i)
    ?? html.match(/class="ts"[^>]*>([^<]+)</i);
  const title = htmlToText(titleMatch?.[1] ?? `Community thread ${tid}`);
  if (isCommunityNoise(title)) return null;

  const postMatch = html.match(/<td[^>]*class="t_f"[^>]*id="postmessage_\d+"[^>]*>([\s\S]*?)<\/td>/i)
    ?? html.match(/id="postmessage_\d+"[^>]*>([\s\S]*?)<\/td>/i);
  if (!postMatch) return null;
  const body = htmlToText(postMatch[1]);
  if (body.length < 40) return null;

  const product = inferProductFromText(`${title}\n${body}`);
  const id = `community_${tid}`;
  return {
    id,
    source: 'community',
    sourceUrl,
    product,
    title,
    text: `# ${title}\n\nSource: ${sourceUrl}\n\n${body}`,
    trustLevel: 'internal',
    fetchedAt: new Date().toISOString()
  };
}

export interface KbNavArticle {
  articleId: string;
  articleType: number;
  title: string;
  product: ProductCode;
  link: string;
}

export function parseKbCategoryNavigation(json: unknown, baseUrl: string): KbNavArticle[] {
  const articles: KbNavArticle[] = [];
  const seen = new Set<string>();

  function walk(node: unknown, context = ''): void {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(item => walk(item, context));
      return;
    }
    const obj = node as Record<string, unknown>;
    const name = String(obj.name ?? obj.title ?? '');
    const link = String(obj.link ?? '');
    const ctx = name ? `${context} ${name}` : context;

    if (link.includes('articleData=')) {
      try {
        const encoded = link.split('articleData=')[1]?.split('&')[0] ?? '';
        const data = JSON.parse(decodeURIComponent(encoded)) as { articleId?: string; articleType?: number };
        if (data.articleId && !seen.has(data.articleId)) {
          seen.add(data.articleId);
          articles.push({
            articleId: data.articleId,
            articleType: data.articleType ?? 1,
            title: name || `KB article ${data.articleId}`,
            product: inferProductFromText(ctx),
            link: link.startsWith('http') ? link : `${baseUrl.replace(/\/$/, '')}${link}`
          });
        }
      } catch {
        // ignore malformed article links
      }
    }

    for (const value of Object.values(obj)) walk(value, ctx);
  }

  walk(json);
  return articles;
}

export async function fetchKbArticleMarkdown(
  article: KbNavArticle,
  token: string,
  baseUrl: string
): Promise<string | null> {
  const url = `${baseUrl.replace(/\/$/, '')}/api-kb/article/front/markDown`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=UTF-8',
      authorization: `Bearer ${token}`,
      'user-agent': USER_AGENT
    },
    body: JSON.stringify({ articleId: article.articleId, articleType: article.articleType })
  });
  if (!res.ok) return null;
  const data = await res.json() as { data?: { content?: string; markdown?: string }; content?: string };
  const content = data?.data?.markdown ?? data?.data?.content ?? data?.content;
  return typeof content === 'string' && content.trim() ? content : null;
}

export function catalogStubMarkdown(article: KbNavArticle, baseUrl: string): string {
  return [
    `# ${article.title}`,
    '',
    `Source: knowledgebase.sangfor.com (catalog entry)`,
    `Article ID: ${article.articleId}`,
    `Product area: ${article.product}`,
    `Link: ${article.link.startsWith('http') ? article.link : `${baseUrl}${article.link}`}`,
    '',
    'Full article body requires SANGFOR_KB_TOKEN for authenticated markdown API fetch.',
    'Use this entry for navigation and product-area context until token-backed sync runs.'
  ].join('\n');
}

export async function collectCommunityThreads(options: CollectOptions = {}): Promise<CollectedDocument[]> {
  const base = options.communityBaseUrl ?? 'https://community.sangfor.com';
  const forumIds = options.forumIds ?? DEFAULT_FORUM_IDS;
  const maxPerForum = options.communityMaxThreadsPerForum ?? 8;
  const docs: CollectedDocument[] = [];

  for (const fid of forumIds) {
    const listUrl = `${base}/forum.php?mod=forumdisplay&fid=${fid}`;
    let listHtml: string;
    try {
      listHtml = await fetchText(listUrl);
    } catch {
      continue;
    }
    const tids = parseCommunityThreadIds(listHtml).slice(0, maxPerForum);
    for (const tid of tids) {
      const threadUrl = `${base}/forum.php?mod=viewthread&tid=${tid}`;
      try {
        const html = await fetchText(threadUrl);
        const doc = parseCommunityThread(html, tid, threadUrl);
        if (doc) docs.push(doc);
      } catch {
        // skip failed thread
      }
      await delay(400);
    }
    await delay(500);
  }
  return docs;
}

export async function collectKnowledgeCatalog(options: CollectOptions = {}): Promise<CollectedDocument[]> {
  const kbBase = options.kbBaseUrl ?? 'https://knowledgebase.sangfor.com';
  const knowledgeHost = 'https://knowledge.sangfor.com';
  const navUrl = `${kbBase}/category-navigation.json`;
  let navJson: unknown;
  try {
    navJson = JSON.parse(await fetchText(navUrl));
  } catch (err) {
    throw new Error(`Failed to load KB catalog from ${navUrl} (knowledge.sangfor.com may redirect to knowledgebase): ${err}`);
  }

  const articles = parseKbCategoryNavigation(navJson, kbBase);
  const max = options.knowledgeMaxArticles ?? 40;
  const token = options.kbToken?.trim();
  const selected = articles.slice(0, max);
  const docs: CollectedDocument[] = [];

  for (const article of selected) {
    let text = catalogStubMarkdown(article, kbBase);
    if (token) {
      const md = await fetchKbArticleMarkdown(article, token, kbBase);
      if (md) {
        text = `# ${article.title}\n\nSource: ${knowledgeHost} / knowledgebase.sangfor.com\nArticle ID: ${article.articleId}\n\n${md}`;
      }
    }
    docs.push({
      id: `kb_${article.articleId}`,
      source: token ? 'knowledge' : 'knowledge_catalog',
      sourceUrl: article.link.startsWith('http') ? article.link : `${kbBase}${article.link}`,
      product: article.product,
      title: article.title,
      text,
      trustLevel: 'official',
      fetchedAt: new Date().toISOString()
    });
    await delay(300);
  }
  return docs;
}

export function saveCollectedDocuments(docs: CollectedDocument[], rawDir: string): string[] {
  mkdirSync(rawDir, { recursive: true });
  const paths: string[] = [];
  for (const doc of docs) {
    const safeName = doc.id.replace(/[^a-zA-Z0-9_-]/g, '_');
    const path = join(rawDir, `${safeName}.md`);
    const frontmatter = [
      '---',
      `id: ${doc.id}`,
      `source: ${doc.source}`,
      `sourceUrl: ${doc.sourceUrl}`,
      `product: ${doc.product}`,
      `trustLevel: ${doc.trustLevel}`,
      `fetchedAt: ${doc.fetchedAt}`,
      '---',
      ''
    ].join('\n');
    writeFileSync(path, `${frontmatter}${doc.text}\n`, 'utf8');
    paths.push(path);
  }
  return paths;
}

export function loadCollectedManifest(manifestPath: string): CollectedDocument[] {
  if (!existsSync(manifestPath)) return [];
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as CollectedDocument[];
}

export function saveCollectedManifest(docs: CollectedDocument[], manifestPath: string): void {
  mkdirSync(manifestPath.split('/').slice(0, -1).join('/') || '.', { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(docs, null, 2));
}

export function sanitizeForFineTune(text: string): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b\+?\d[\d\s()-]{8,}\d\b/g, '[phone]')
    .replace(/\b(?:password|passwd|api[_-]?key|secret|token)\s*[:=]\s*\S+/gi, '[redacted]')
    .replace(/\bpassword\b/gi, 'credential')
    .replace(/\botp\b/gi, 'one-time-code')
    .replace(/\bmfa\b/gi, 'multi-factor-auth')
    .replace(/\blicense key\b/gi, 'license-reference');
}

export function docsToFineTuneExamples(docs: CollectedDocument[]): Array<{ input: string; expectedOutput: string; source: string }> {
  return docs.map(doc => ({
    input: `[${doc.product}] Summarize key engineering guidance from: ${doc.title}`,
    expectedOutput: sanitizeForFineTune(doc.text).slice(0, 1200),
    source: doc.sourceUrl
  }));
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
