import { KnowledgeChunk, ProductCode } from '@sangfor/shared';

export interface WikiUpdateProposal {
  id: string;
  targetPage: string;
  title: string;
  beforeText: string;
  afterText: string;
  status: 'pending' | 'approved' | 'rejected' | 'applied';
  adapter?: 'memory' | 'obsidian' | 'github_wiki';
  reviewer?: string;
}

export type KnowledgeCardType = 'procedure' | 'troubleshooting' | 'known_issue' | 'config_recipe' | 'compatibility_note';

export interface KnowledgeCardCitation {
  sourceId: string;
  sourceRevision?: string;
  headingPath?: string[];
  spanText: string;
  quoteHash: string;
}

export interface KnowledgeCard {
  id: string;
  type: KnowledgeCardType;
  product: ProductCode;
  version?: string;
  title: string;
  symptom?: string;
  cause?: string;
  prerequisites: string[];
  steps: string[];
  warnings: string[];
  verification: string[];
  rollback: string[];
  citations: KnowledgeCardCitation[];
  trustLevel: KnowledgeChunk['trustLevel'];
  updatedAt: string;
}

export interface WikiAdapter {
  readPage(path: string): Promise<string>;
  writePage(path: string, content: string, message: string): Promise<{ ok: boolean; path: string; message: string }>;
}
