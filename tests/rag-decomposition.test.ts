import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';

const RAG_RUNTIME_MODULES = [
  '../packages/sangfor-rag/src/index.ts',
  '../packages/sangfor-rag/src/rag-types.ts',
  '../packages/sangfor-rag/src/rag-index-store.ts',
  '../packages/sangfor-rag/src/document-extraction.ts',
  '../packages/sangfor-rag/src/rag-ranking.ts',
  '../packages/sangfor-rag/src/rag-ingest.ts',
  '../packages/sangfor-rag/src/rag-search.ts',
] as const;

function pureLineCount(source: string): number {
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed !== '' && !trimmed.startsWith('//') && !trimmed.startsWith('#');
    })
    .length;
}

describe('RAG runtime module boundaries', () => {
  it('Given the RAG runtime, When module sizes are audited, Then every responsibility stays reviewable', () => {
    // Given
    const modules = RAG_RUNTIME_MODULES.map((relativePath) => new URL(relativePath, import.meta.url));

    // When
    const oversizedOrMissing = modules.flatMap((fileUrl) => {
      if (!existsSync(fileUrl)) return [`${basename(fileUrl.pathname)}:missing`];
      const lines = pureLineCount(readFileSync(fileUrl, 'utf8'));
      return lines > 250 ? [`${basename(fileUrl.pathname)}:${lines}`] : [];
    });

    // Then
    expect(oversizedOrMissing).toEqual([]);
  });

  it('Given malformed embedding-provider metadata, When its boundary is inspected, Then no unsafe assertion bypasses narrowing', () => {
    // Given
    const sources = RAG_RUNTIME_MODULES.map((relativePath) =>
      readFileSync(new URL(relativePath, import.meta.url), 'utf8'));

    // When
    const unsafeBoundaryAssertion = sources.some((source) => source.includes('provider as unknown as'));

    // Then
    expect(unsafeBoundaryAssertion).toBe(false);
  });
});
