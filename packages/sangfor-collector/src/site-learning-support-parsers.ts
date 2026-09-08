import type {
  SupportCase,
  SupportLeaf,
  SupportProductVersion,
  SupportShowcaseRow,
  SupportTreeNode,
} from './site-learning-types.js';

type SupportVersionRecord = {
  id: number;
  name: string;
  product_id: number;
};

type SupportProductRecord = {
  id: number;
  name: string;
  version: SupportVersionRecord[];
};

type SupportProductResponse = {
  code?: number;
  data?: Record<string, SupportProductRecord>;
};

export function parseSupportProductVersions(value: unknown): SupportProductVersion[] {
  if (!value || typeof value !== 'object') return [];
  const response = value as SupportProductResponse;
  if (!response.data || typeof response.data !== 'object') return [];
  return Object.values(response.data).flatMap((product) => {
    if (!Number.isInteger(product.id) || !product.name || !Array.isArray(product.version)) return [];
    return product.version
      .filter((version) =>
        Number.isInteger(version.id)
        && Number.isInteger(version.product_id)
        && version.product_id === product.id
        && Boolean(version.name))
      .map((version) => ({
        productId: product.id,
        productName: product.name,
        versionId: version.id,
        versionName: version.name,
      }));
  });
}

export function selectSupportProductVersions(
  versions: SupportProductVersion[],
): SupportProductVersion[] {
  return versions.filter((version) => !/^\s*all versions?\s*$/i.test(version.versionName));
}

export function sliceToOptionalLimit<T>(values: T[], limit: number | undefined): T[] {
  return limit === undefined ? values : values.slice(0, limit);
}

export function flattenSupportLeaves(
  nodes: SupportTreeNode[],
  trail: string[] = [],
): SupportLeaf[] {
  return nodes.flatMap((node) => {
    const path = [...trail, node.name];
    return node.children?.length
      ? flattenSupportLeaves(node.children, path)
      : [{ categoryId: node.id, path }];
  });
}

export function parseSupportShowcaseRows(value: unknown): SupportShowcaseRow[] {
  if (!value || typeof value !== 'object') return [];
  const rows = (value as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const record = row as Record<string, unknown>;
    if (!Number.isInteger(record.id) || typeof record.code !== 'string'
      || typeof record.name !== 'string' || typeof record.linkUrl !== 'string') return [];
    return [{
      id: record.id as number,
      code: record.code,
      name: record.name,
      linkUrl: record.linkUrl.trim(),
      remark: typeof record.remark === 'string' ? record.remark : '',
    }];
  });
}

function stripHtml(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseSupportCasePage(value: unknown): {
  totalPages: number;
  cases: SupportCase[];
} {
  if (!value || typeof value !== 'object') return { totalPages: 0, cases: [] };
  const rows = (value as { rows?: unknown }).rows;
  if (!rows || typeof rows !== 'object') return { totalPages: 0, cases: [] };
  const record = rows as { totalPages?: unknown; content?: unknown };
  const totalPages = Number(record.totalPages);
  const content = Array.isArray(record.content) ? record.content : [];
  const cases = content.flatMap((item): SupportCase[] => {
    if (!item || typeof item !== 'object') return [];
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== 'string' || typeof entry.title !== 'string'
      || typeof entry.content !== 'string') return [];
    const productId = Number(entry.product);
    if (!Number.isInteger(productId)) return [];
    return [{
      id: entry.id,
      title: stripHtml(entry.title),
      text: stripHtml(entry.content),
      productId,
    }];
  });
  return {
    totalPages: Number.isInteger(totalPages) && totalPages >= 0 ? totalPages : 0,
    cases,
  };
}
