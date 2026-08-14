import { createHash } from 'node:crypto';
import { ProductCode, normalizeProduct } from '@sangfor/shared';

export type DocumentBlockType = 'heading' | 'paragraph' | 'list' | 'table' | 'code' | 'warning';

export interface DocumentBlock {
  id: string;
  sourceId: string;
  sourceRevision: string;
  product: ProductCode;
  version?: string;
  title: string;
  headingPath: string[];
  blockType: DocumentBlockType;
  text: string;
  ordinal: number;
  canonicalHash: string;
}

export interface ExtractDocumentBlocksInput {
  sourceId: string;
  sourceRevision?: string;
  product?: string;
  version?: string;
  title?: string;
  text: string;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function stripFrontMatter(text: string): { metadata: Record<string, string>; body: string } {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { metadata: {}, body: text };
  const metadata = Object.fromEntries(match[1].split(/\r?\n/).flatMap((line) => {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
    return kv ? [[kv[1], kv[2].replace(/^["']|["']$/g, '')]] : [];
  }));
  return { metadata, body: text.slice(match[0].length) };
}

function classifyBlock(text: string): DocumentBlockType {
  if (/^```/.test(text)) return 'code';
  if (/^\|.+\|$/m.test(text)) return 'table';
  if (/^\s*[-*]\s+|^\s*\d+[.)]\s+/m.test(text)) return 'list';
  if (/warning|caution|주의|경고|rollback|롤백/i.test(text)) return 'warning';
  return 'paragraph';
}

export function extractDocumentBlocks(input: ExtractDocumentBlocksInput): DocumentBlock[] {
  const { metadata, body } = stripFrontMatter(input.text.replace(/\r\n/g, '\n'));
  const product = normalizeProduct(input.product ?? metadata.product);
  const version = input.version ?? metadata.version;
  const title = input.title ?? metadata.title ?? body.match(/^#\s+(.+)$/m)?.[1] ?? input.sourceId;
  const sourceRevision = input.sourceRevision ?? metadata.contentHash ?? sha256(input.text);
  const blocks: DocumentBlock[] = [];
  const headings: string[] = [];
  let buffer: string[] = [];
  let inCode = false;

  const flush = () => {
    const text = buffer.join('\n').trim();
    buffer = [];
    if (!text) return;
    const ordinal = blocks.length;
    blocks.push({
      id: `block_${sha256(`${input.sourceId}:${sourceRevision}:${ordinal}:${text}`).slice(0, 16)}`,
      sourceId: input.sourceId,
      sourceRevision,
      product,
      version,
      title,
      headingPath: [...headings],
      blockType: classifyBlock(text),
      text,
      ordinal,
      canonicalHash: sha256(text.replace(/\s+/g, ' ').trim())
    });
  };

  for (const line of body.split('\n')) {
    if (line.startsWith('```')) {
      buffer.push(line);
      inCode = !inCode;
      if (!inCode) flush();
      continue;
    }
    if (!inCode) {
      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        flush();
        const level = heading[1].length;
        headings.splice(level - 1, headings.length, heading[2].trim());
        const ordinal = blocks.length;
        blocks.push({
          id: `block_${sha256(`${input.sourceId}:${sourceRevision}:h:${ordinal}:${line}`).slice(0, 16)}`,
          sourceId: input.sourceId,
          sourceRevision,
          product,
          version,
          title,
          headingPath: [...headings],
          blockType: 'heading',
          text: heading[2].trim(),
          ordinal,
          canonicalHash: sha256(heading[2].replace(/\s+/g, ' ').trim())
        });
        continue;
      }
      if (!line.trim()) {
        flush();
        continue;
      }
    }
    buffer.push(line);
  }
  flush();
  return blocks;
}
