export interface ReconciliationChunk {
  id?: string;
  filePath: string;
  product: string;
  title?: string;
  version?: string;
  [key: string]: unknown;
}

export function classifyProduct(chunk: Pick<ReconciliationChunk, 'product' | 'title'>): string;
export function titleVersion(title?: string): string | undefined;
export function reconcileChunks(
  chunks: ReconciliationChunk[],
  pathExists?: (path: string) => boolean
): {
  chunks: ReconciliationChunk[];
  orphanChunksRemoved: number;
  productCorrections: number;
  versionCorrections: number;
};
