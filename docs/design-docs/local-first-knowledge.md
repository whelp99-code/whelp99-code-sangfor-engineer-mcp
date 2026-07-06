# Decision: Local-first knowledge, gated cloud

**Status:** verified

## Context
The knowledge base ingests Sangfor manuals, KB articles, and community threads — some carry customer-specific detail. Embeddings and rerank could be sent to a cloud provider for quality, but doing so by default would leak potentially sensitive content and make the pipeline fail without network access.

## Decision
- **Embeddings run locally by default.** `SANGFOR_EMBEDDING_PROVIDER` defaults to `rapid-mlx` — an OpenAI-compatible MLX server on the local machine (`SANGFOR_RAPID_MLX_BASE_URL`, default `127.0.0.1:8000/v1`).
- **Deterministic hash fallback.** If a provider fails its health check or times out, `HashEmbeddingProvider` (SHA-256 token-bucket vectors, no network) takes over, so ingest and search *always* work offline. `ragSearchSync` is hash-only for tests.
- **The vector index is a local JSON file** (`data/rag/index.json`), searched by an in-process cosine scan — no external vector DB.
- **Cloud is explicitly gated.** LiteLLM proxy embeddings and MiMo rerank require their env config plus `SANGFOR_ALLOW_CLOUD_RAG`. Customer-trust-level documents are excluded from search results unless `SANGFOR_ALLOW_CLOUD_RAG_CUSTOMER=1`.

## Rationale
- **Privacy**: customer content never leaves the machine unless an operator opts in.
- **Resilience**: the pipeline degrades to a working (lower-quality) state rather than erroring when a provider is down.
- **Reproducibility**: the hash provider makes tests deterministic without a model server.

## Consequences
- Search quality depends on the configured provider; the hash fallback is intentionally weak (lexical), so quality checks should note which backend produced an index (`RagIndex.version` bumps to 2 when any chunk is semantic).
- The Postgres RAG models (`SangforRagDocument/Chunk`) are a *mirror* for the optional `@sangfor/store` bridge, not the search path — actual retrieval is always the local index.
- Related: [ARCHITECTURE.md](../../ARCHITECTURE.md#data-flow-learning-pipeline), [SECURITY.md](../SECURITY.md).
