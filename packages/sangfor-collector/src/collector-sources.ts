import { catalogStubMarkdown, fetchKbArticleMarkdown } from './collector-knowledge.js';
import { parseCommunityThread, parseCommunityThreadIds } from './collector-community.js';
import type { CollectOptions, CollectedDocument, KbNavArticle } from './collector-types.js';

const DEFAULT_FORUM_IDS = [156, 157, 158, 167, 89, 92, 137, 138] as const;
const USER_AGENT = 'sangfor-engineer-mcp/0.1 (learning-pipeline; +https://github.com/whelp99-code/whelp99-code-sangfor-engineer-mcp)';

export async function fetchText(url: string, headers: Record<string, string> = {}): Promise<string> {
  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/json,*/*', ...headers },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.text();
}

export async function collectCommunityThreads(options: CollectOptions = {}): Promise<CollectedDocument[]> {
  const base = options.communityBaseUrl ?? 'https://community.sangfor.com';
  const forumIds = options.forumIds ?? DEFAULT_FORUM_IDS;
  const maxPerForum = options.communityMaxThreadsPerForum;
  const documents: CollectedDocument[] = [];

  for (const forumId of forumIds) {
    const listUrl = `${base}/forum.php?mod=forumdisplay&fid=${forumId}`;
    let listHtml: string;
    try {
      listHtml = await fetchText(listUrl);
    } catch {
      continue;
    }
    const allThreadIds = parseCommunityThreadIds(listHtml);
    const threadIds = maxPerForum === undefined ? allThreadIds : allThreadIds.slice(0, maxPerForum);
    for (const threadId of threadIds) {
      const threadUrl = `${base}/forum.php?mod=viewthread&tid=${threadId}`;
      try {
        const html = await fetchText(threadUrl);
        const document = parseCommunityThread(html, threadId, threadUrl);
        if (document) documents.push(document);
      } catch { // no-excuse-ok: catch
        // Preserve best-effort collection: one failed thread does not abort its forum.
      }
      await delay(400);
    }
    await delay(500);
  }
  return documents;
}

export async function collectKnowledgeCatalogCore(
  options: CollectOptions,
  parseNavigation: (json: unknown, baseUrl: string) => KbNavArticle[],
): Promise<CollectedDocument[]> {
  const kbBase = options.kbBaseUrl ?? 'https://knowledgebase.sangfor.com';
  const knowledgeHost = 'https://knowledge.sangfor.com';
  const navigationUrl = `${kbBase}/category-navigation.json`;
  let navigationJson: unknown;
  try {
    navigationJson = JSON.parse(await fetchText(navigationUrl));
  } catch (error) {
    throw new Error(`Failed to load KB catalog from ${navigationUrl} (knowledge.sangfor.com may redirect to knowledgebase): ${error}`);
  }

  const articles = parseNavigation(navigationJson, kbBase);
  const selected = options.knowledgeMaxArticles === undefined
    ? articles
    : articles.slice(0, options.knowledgeMaxArticles);
  const token = options.kbToken?.trim();
  const documents: CollectedDocument[] = [];

  for (const article of selected) {
    let text = catalogStubMarkdown(article, kbBase);
    if (token) {
      const markdown = await fetchKbArticleMarkdown(article, token, kbBase);
      if (markdown) {
        text = `# ${article.title}\n\nSource: ${knowledgeHost} / knowledgebase.sangfor.com\nArticle ID: ${article.articleId}\n\n${markdown}`;
      }
    }
    documents.push({
      id: `kb_${article.articleId}`,
      source: token ? 'knowledge' : 'knowledge_catalog',
      sourceUrl: article.link.startsWith('http') ? article.link : `${kbBase}${article.link}`,
      product: article.product,
      title: article.title,
      text,
      trustLevel: 'official',
      fetchedAt: new Date().toISOString(),
    });
    await delay(300);
  }
  return documents;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
