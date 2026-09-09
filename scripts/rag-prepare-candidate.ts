/** Create a new local lexical candidate. Never promotes or rewrites the source index. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadRagIndex, saveRagIndex } from '../packages/sangfor-rag/src/index.js';
import { cleanRetrievalText, documentVersionFromTitle } from '../packages/sangfor-rag/src/retrieval-text.js';

const [sourcePath, outputPath] = process.argv.slice(2);
if (!sourcePath || !outputPath || process.argv.length !== 4) throw new Error('Usage: pnpm run rag:prepare:candidate <source.json> <new-candidate.json>');
if (resolve(sourcePath) === resolve(outputPath) || existsSync(outputPath)) throw new Error('RAG_PREPARE_REQUIRES_NEW_CANDIDATE_PATH');
const bytes = readFileSync(sourcePath);
const source = loadRagIndex(sourcePath);
let cleaned = 0;
let versionsAdded = 0;
const chunks = source.chunks.map((chunk) => {
  const text = cleanRetrievalText(chunk.text);
  const version = chunk.version ?? documentVersionFromTitle(chunk.title);
  if (!chunk.version && version) versionsAdded++;
  if (text === chunk.text) return { ...chunk, version };
  cleaned++;
  // Old vectors describe old bytes. Require a real re-embedding before semantic use.
  return { ...chunk, text, version, vector: [], vectorDims: undefined, embeddingSpace: undefined,
    contentHash: createHash('sha256').update(`${chunk.filePath}:${chunk.id}:${text}`).digest('hex') };
});
if (!readFileSync(sourcePath).equals(bytes)) throw new Error('RAG_PREPARE_SOURCE_CHANGED');
saveRagIndex({ ...source, chunks }, outputPath);
const roundTrip = loadRagIndex(outputPath);
if (roundTrip.chunks.length !== source.chunks.length) throw new Error('RAG_PREPARE_READBACK_MISMATCH');
console.log(JSON.stringify({ sourceSha256: createHash('sha256').update(bytes).digest('hex'),
  candidateSha256: createHash('sha256').update(readFileSync(outputPath)).digest('hex'),
  chunks: chunks.length, cleaned, versionsAdded, invalidatedVectors: cleaned,
  promotionAuthorized: false, outputPath }, null, 2));
