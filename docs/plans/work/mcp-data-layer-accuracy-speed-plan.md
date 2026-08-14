# MCP Data Layer Accuracy and Speed Improvement Plan

## Decision

Move the MCP data layer from "raw chunk search" toward a measured,
source-verifiable retrieval stack:

1. safe embedding/profile guardrails,
2. target-domain retrieval evaluation,
3. clean document/block identity,
4. knowledge-card/wiki retrieval,
5. indexed search/storage after quality is measurable.

This plan deliberately does **not** start by adopting a RAG framework. The
current bottlenecks are extraction quality, silent truncation/fallback, metadata
accuracy, stale index lifecycle, and O(n) search over a large JSON index.

## Accuracy goals

- Retrieve the correct product/version source first.
- Retrieve every critical evidence atom for field procedures: prerequisite,
  warning, command/action, verification, and rollback where applicable.
- Refuse or degrade loudly when embeddings, model identity, or dimensions do not
  match the index generation.
- Keep LLM-generated wiki/card facts tied to source-span citations.

## Speed goals

- Reduce candidate set size before ranking through product/version/source
  filtering and duplicate-source collapse.
- Stop repeatedly tokenizing and scanning the full JSON index as the long-term
  search path.
- Benchmark sharded JSONL, sqlite-vec, and LanceDB only after the retrieval
  quality baseline exists.

## Execution phases

### Phase 1: Guardrails and observability

- Record the effective embedding backend/model/dimensions on search and reembed.
- Fail re-embedding when the requested semantic provider has fallen back to hash.
- Report vector dimension and model-cohort mismatches in search diagnostics.
- Capture model/index/corpus fingerprints in benchmark output.

### Phase 2: Retrieval benchmark foundation

- Add a deterministic benchmark format with stable source IDs, source revisions,
  product/version applicability, and required evidence atoms.
- Keep chunk IDs and content hashes out of gold labels because rechunking changes
  them.
- Use source-deduplicated Hit@5, Recall@5, MRR@10, and nDCG@10 as diagnostics.
- Gate releases on critical evidence atom coverage, wrong-version rate,
  unsafe-context rate, no-answer behavior, latency, and index size.

### Phase 3: Data normalization

- Preserve raw sources and raw hashes.
- Build a clean document/block IR before rechunking.
- Promote front matter, product, version, source URL, trust, and source revision
  into metadata instead of embedding them as body text.
- Implement exact canonical replacement before near-duplicate deletion.

### Phase 4: Wiki/card layer

- Extend the existing `sangfor-wiki` package from lesson proposals into
  source-cited `KnowledgeCard` records.
- Search cards first for procedure/troubleshooting/known-issue answers.
- Fall back to raw evidence search for verification, freshness, and missing
  cards.

### Phase 5: Model, chunking, and storage bakeoffs

- Compare current MiniLM with corrected effective max length against
  `intfloat/multilingual-e5-small` with correct `query:` / `passage:` roles.
- Compare current chunks, bounded structure-aware chunks, and semantic chunks as
  separate arms under the same retrieved-token budget.
- Only after quality passes, run storage bakeoff for sharded JSONL, sqlite-vec,
  and LanceDB.

## First implementation slice

This slice is safe and non-destructive:

- Add loud search diagnostics for hash fallback, vector dimension mismatch, and
  mixed model cohorts.
- Make `scripts/rag-reembed.ts` refuse hash-fallback re-embeds unless explicitly
  overridden.
- Add retrieval metric helpers and tests to support future benchmark CLI work.

## Non-goals for this slice

- No destructive index migration.
- No vector database adoption.
- No new Python runtime dependency.
- No LLM-generated wiki cards without citation/eval gates.
