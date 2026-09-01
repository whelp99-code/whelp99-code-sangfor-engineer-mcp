import { RuntimeSchemaError } from '../../shared/src/runtime-schema.js';
import { inferProductFromText } from './collector-community.js';
import type { ArticleDataParser, KbNavArticle } from './collector-types.js';

export function parseKbCategoryNavigationCore(
  json: unknown,
  baseUrl: string,
  parseArticleData: ArticleDataParser,
): KbNavArticle[] {
  const articles: KbNavArticle[] = [];
  const seen = new Set<string>();

  function walk(node: unknown, context = ''): void {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((item) => walk(item, context));
      return;
    }
    const object = node as Record<string, unknown>;
    const name = String(object.name ?? object.title ?? '');
    const link = String(object.link ?? '');
    const nextContext = name ? `${context} ${name}` : context;

    if (link.includes('articleData=')) {
      try {
        const encoded = link.split('articleData=')[1]?.split('&')[0] ?? '';
        const data = parseArticleData(decodeURIComponent(encoded));
        if (data.articleId && !seen.has(data.articleId)) {
          seen.add(data.articleId);
          articles.push({
            articleId: data.articleId,
            articleType: data.articleType ?? 1,
            title: name || `KB article ${data.articleId}`,
            product: inferProductFromText(nextContext),
            link: link.startsWith('http') ? link : `${baseUrl.replace(/\/$/, '')}${link}`,
          });
        }
      } catch (error) {
        if (!(error instanceof RuntimeSchemaError)) throw error;
        process.stderr.write('[collector] denied invalid articleData link\n');
      }
    }

    for (const value of Object.values(object)) walk(value, nextContext);
  }

  walk(json);
  return articles;
}

export async function fetchKbArticleMarkdown(
  article: KbNavArticle,
  token: string,
  baseUrl: string,
): Promise<string | null> {
  const url = `${baseUrl.replace(/\/$/, '')}/api-kb/article/front/markDown`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=UTF-8',
      authorization: `Bearer ${token}`,
      'user-agent': 'sangfor-engineer-mcp/0.1 (learning-pipeline; +https://github.com/whelp99-code/whelp99-code-sangfor-engineer-mcp)',
    },
    body: JSON.stringify({ articleId: article.articleId, articleType: article.articleType }),
  });
  if (!response.ok) return null;
  const data = await response.json() as {
    data?: { content?: string; markdown?: string };
    content?: string;
  };
  const content = data.data?.markdown ?? data.data?.content ?? data.content;
  return typeof content === 'string' && content.trim() ? content : null;
}

export function catalogStubMarkdown(article: KbNavArticle, baseUrl: string): string {
  return [
    `# ${article.title}`,
    '',
    'Source: knowledgebase.sangfor.com (catalog entry)',
    `Article ID: ${article.articleId}`,
    `Product area: ${article.product}`,
    `Link: ${article.link.startsWith('http') ? article.link : `${baseUrl}${article.link}`}`,
    '',
    'Full article body requires SANGFOR_KB_TOKEN for authenticated markdown API fetch.',
    'Use this entry for navigation and product-area context until token-backed sync runs.',
  ].join('\n');
}
