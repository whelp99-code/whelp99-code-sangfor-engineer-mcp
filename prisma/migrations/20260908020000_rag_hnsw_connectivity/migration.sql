-- Sparse hash vectors with tied distances can leave the m=16 graph disconnected.
-- Increase connectivity without modifying embedding values or recall thresholds.
-- This trades index/build cost for connectivity; actual-corpus promotion still
-- requires independently measured recall and latency. Rebuild changes identity,
-- so old signed index evidence cannot authorize the new index.
BEGIN;
ALTER INDEX "BlroRagEmbedding_embedding_hnsw_idx" SET (m=100, ef_construction=1000);
REINDEX INDEX "BlroRagEmbedding_embedding_hnsw_idx";
COMMIT;
