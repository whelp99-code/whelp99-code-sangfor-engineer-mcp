import type { ProductCode } from '@sangfor/shared';

export type SourceKind =
  | 'knowledge'
  | 'community'
  | 'knowledge_catalog'
  | 'support_site'
  | 'community_site';

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
  /** Omit or undefined = no per-forum cap (all threads on first page). */
  communityMaxThreadsPerForum?: number;
  /** Omit or undefined = entire catalog from navigation JSON. */
  knowledgeMaxArticles?: number;
  kbToken?: string;
  kbBaseUrl?: string;
  communityBaseUrl?: string;
  rawDir?: string;
  forumIds?: number[];
}

export interface KbNavArticle {
  articleId: string;
  articleType: number;
  title: string;
  product: ProductCode;
  link: string;
}

export type ArticleDataParser = (
  source: string,
) => { readonly articleId?: string; readonly articleType?: number };

export type ManifestParser = (source: string) => CollectedDocument[];
