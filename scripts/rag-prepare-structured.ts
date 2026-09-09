/** New lexical candidate only; source metadata and scope are never inferred. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadRagIndex, saveRagIndex, type RagDocumentChunk } from '../packages/sangfor-rag/src/index.js';
import { joinOverlappingChunks, stripSupportChrome, structuredChunks } from '../packages/sangfor-rag/src/structured-chunks.js';
const [sourcePath, outputPath] = process.argv.slice(2);
if (!sourcePath || !outputPath || process.argv.length !== 4) throw new Error('Usage: pnpm run rag:prepare:structured <source.json> <new-candidate.json>');
if (resolve(sourcePath) === resolve(outputPath) || existsSync(outputPath)) throw new Error('RAG_PREPARE_REQUIRES_NEW_CANDIDATE_PATH');
const sourceBytes = readFileSync(sourcePath);
const source = loadRagIndex(sourcePath);
const groups = new Map<string, RagDocumentChunk[]>();
for (const c of source.chunks) {
  const key = JSON.stringify([c.filePath, c.tenantId, c.projectId, c.aclActorIds, c.product, c.version, c.trustLevel, c.sourceType, c.title]);
  const group = groups.get(key) ?? []; group.push(c); groups.set(key, group);
}
const chunks: RagDocumentChunk[] = [];
let chromeRemoved = 0;
let duplicatesRemoved = 0;
for (const [key, group] of groups) {
  const reconstructed = joinOverlappingChunks(group.map((c) => c.text));
  const cleaned = stripSupportChrome(reconstructed);
  if (cleaned !== reconstructed) chromeRemoved++;
  const passages = structuredChunks(cleaned);
  const seen = new Set<string>();
  for (const text of passages) {
    if (seen.has(text)) { duplicatesRemoved++; continue; } seen.add(text);
    const hash = createHash('sha256').update(key).update('\0').update(text).digest('hex');
    chunks.push({ ...group[0], id: `structured_${hash}`, text, contentHash: hash,
      vector: [], vectorDims: undefined, embeddingSpace: undefined });
  }
}
if (!readFileSync(sourcePath).equals(sourceBytes)) throw new Error('RAG_PREPARE_SOURCE_CHANGED');
saveRagIndex({ ...source, chunks }, outputPath);
const roundTrip = loadRagIndex(outputPath);
if (roundTrip.chunks.length !== chunks.length || roundTrip.chunks.some((c, i) => c.contentHash !== chunks[i].contentHash || c.text !== chunks[i].text || c.vector.length)) throw new Error('RAG_PREPARE_READBACK_MISMATCH');
console.log(JSON.stringify({ sourceSha256: createHash('sha256').update(sourceBytes).digest('hex'),
  candidateSha256: createHash('sha256').update(readFileSync(outputPath)).digest('hex'),
  sourceChunks: source.chunks.length, candidateChunks: chunks.length, documentGroups: groups.size,
  chromeRemoved, duplicatesRemoved, allVectorsInvalidated: true, promotionAuthorized: false }, null, 2));
