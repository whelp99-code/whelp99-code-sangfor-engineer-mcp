import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadRagIndex } from '../packages/sangfor-rag/src/index.js';
import { actualEmbeddingModelName } from '../packages/sangfor-rag/src/rag-ingest.js';
import { verifyReembedCheckpoint } from '../packages/sangfor-rag/src/reembed-checkpoint.js';
import { embedForRole, getEmbeddingProvider, wasEmbeddingFallback } from '../packages/sangfor-rag/src/embedding-provider.js';
import { cosineSimilarity } from '../packages/sangfor-rag/src/hash-embedding.js';
const [sourcePath, candidatePath] = process.argv.slice(2);
if (!sourcePath || !candidatePath || process.argv.length !== 4) throw new Error('Usage: pnpm run rag:verify:reembed <source.json> <candidate.json>');
const sourceBytes = readFileSync(sourcePath), candidateBytes = readFileSync(candidatePath);
const source = loadRagIndex(sourcePath), candidate = loadRagIndex(candidatePath);
const provider = await getEmbeddingProvider();
if (provider.name === 'hash' || wasEmbeddingFallback()) throw new Error('RAG_VERIFY_REAL_MODEL_REQUIRED');
const model = actualEmbeddingModelName(provider);
verifyReembedCheckpoint(candidate.chunks, source.chunks, provider.name, model);
if (!candidate.chunks.length) throw new Error('RAG_VERIFY_EMPTY_CORPUS');
let minNorm = Infinity, maxNorm = 0;
for (const chunk of candidate.chunks) {
  const norm = Math.sqrt(chunk.vector.reduce((sum, value) => sum + value * value, 0));
  if (Math.abs(norm - 1) > 0.0001) throw new Error('RAG_VERIFY_VECTOR_NORM');
  minNorm = Math.min(minNorm, norm); maxNorm = Math.max(maxNorm, norm);
}
const positions = [...new Set([0, Math.floor(candidate.chunks.length / 3), Math.floor(candidate.chunks.length * 2 / 3), candidate.chunks.length - 1])];
const vectors = await embedForRole(provider, positions.map((position) => candidate.chunks[position].text), 'document');
const cosines = positions.map((position, i) => cosineSimilarity(candidate.chunks[position].vector, vectors[i]));
if (cosines.some((cosine) => cosine < 0.99999)) throw new Error('RAG_VERIFY_MODEL_READBACK_MISMATCH');
if (!readFileSync(sourcePath).equals(sourceBytes) || !readFileSync(candidatePath).equals(candidateBytes)) throw new Error('RAG_VERIFY_INPUT_CHANGED');
console.log(JSON.stringify({ sourceSha256: createHash('sha256').update(sourceBytes).digest('hex'),
  candidateSha256: createHash('sha256').update(candidateBytes).digest('hex'), chunks: candidate.chunks.length,
  model, embeddingSpace: candidate.chunks[0].embeddingSpace, minNorm, maxNorm, spotCheckPositions: positions, spotCheckCosines: cosines,
  sourceMetadataPreserved: true, promotionAuthorized: false }, null, 2));
