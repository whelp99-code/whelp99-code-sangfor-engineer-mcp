import { readSafariLibraryTree } from './lib/kb-browser-session.js';
import { articleIdFromUrl } from './lib/parse-product-tables.js';
import { loadEnvFile } from '../packages/sangfor-collector/src/load-env.js';

loadEnvFile('.env');

function countArticles(json: string): number {
  const seen = new Set<string>();
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return 0;
  }
  function walk(node: unknown): void {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const o = node as Record<string, unknown>;
    const link = String(o.link ?? o.url ?? o.path ?? '');
    if (link.includes('articleId')) {
      const full = link.startsWith('http') ? link : `https://knowledgebase.sangfor.com${link.startsWith('/') ? link : `/${link}`}`;
      const id = articleIdFromUrl(full);
      if (id) seen.add(id);
    }
    for (const v of Object.values(o)) walk(v);
  }
  walk(data);
  return seen.size;
}

async function main() {
  const tree = readSafariLibraryTree();
  console.log(JSON.stringify({
    treeBytes: tree?.length ?? 0,
    articleIds: tree ? countArticles(tree) : 0,
    preview: tree?.slice(0, 200)
  }, null, 2));
}

main();
