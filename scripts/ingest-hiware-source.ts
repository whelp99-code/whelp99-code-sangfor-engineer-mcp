import { resolve } from 'node:path';
import {
  exportRagIndexSummary,
  ingestDocument
} from '../packages/sangfor-rag/src/index.js';

const sourcePath = resolve('data/sources/hiware-menu-inventory.md');
const result = await ingestDocument({
  filePath: sourcePath,
  product: 'HIWARE',
  sourceType: 'manual',
  trustLevel: 'internal',
  title: 'HIWARE 6 privileged access menu inventory'
});

console.log(JSON.stringify({
  result: {
    documentId: result.documentId,
    chunkCount: result.chunkCount,
    indexPath: result.indexPath,
    embeddingBackend: result.embeddingBackend
  },
  summary: exportRagIndexSummary(result.indexPath)
}, null, 2));
