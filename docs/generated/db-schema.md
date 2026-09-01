# Database Schema (generated)

- **Source:** `prisma/schema.prisma` (`provider = postgresql`, `url = env("DATABASE_URL")`)
- **Generated:** 2026-08-27 — regenerate by hand from the schema when models change (or `pnpm run db:generate` for the client).
- **Status:** Legacy `Sangfor*` models remain an optional bridge. `Blro*` authority models, including PostgreSQL-native RAG, are primary in BLRO cutover mode; file state is never an authority fallback.

## Models

| Model | Key fields | Notes |
|---|---|---|
| `SangforProduct` | `code @unique`, `name`, `priority`, `enabled` | Product catalog (mirrors `@sangfor/shared` `PRODUCTS`). |
| `SangforManual` | `product`, `version?`, `title`, `sourceType`, `sourceUrl?`, `filePath?`, `trustLevel` (default `needs_review`) | Ingested manual metadata. |
| `SangforProject` | `customerName`, `product`, `projectType`, `status` (default `draft`) | Engagement/project record. |
| `SangforConfigPlan` | `projectId?`, `product`, `planTitle`, `planJson` (Json), `riskLevel`, `status` | Persisted planner output (`persistConfigPlan`). |
| `SangforFeedbackEvent` | `product`, `feedbackType`, `severity`, `feedbackText`, `sourceRole`, `status` (default `new`) | Feedback capture (`persistFeedbackEvent`); in-app source (`@sangfor/sangfor-feedback`) is now persisted as file-based JSONL, not in-memory. |
| `SangforWikiUpdateProposal` | `targetPage`, `title`, `beforeText`, `afterText`, `status` (default `pending`) | Review-gated wiki proposal. |
| `SangforRagDocument` | `productCode`, `version?`, `title`, `sourceType`, `filePath`, `contentHash @unique`, → `chunks` | Mirror of a `data/rag/index.json` document (`upsertRagDocumentMeta`). |
| `SangforRagChunk` | `documentId` → `SangforRagDocument`, `productCode`, `section?`, `chunkText`, `vector Json?`, `contentHash @unique` | Legacy compatibility mirror; not BLRO authority. |
| `BlroRagAuthoritativeChunk` | composite tenant/project/id, actor membership, product/version/source/trust/ACL | Authoritative scoped source and filter metadata under FORCE RLS. |
| `BlroRagEmbeddingCohort` | composite scope/id, index epoch, backend/model/dimensions, active | Database-enforced single active cohort per tenant/project scope. |
| `BlroRagEmbedding` | scoped chunk/cohort FKs, duplicated pre-ranking filters, `vector(384)` | pgvector exact cosine and HNSW `vector_cosine_ops` search under FORCE RLS. |
| `BlroRagIndexPromotion` | composite scope/cohort/epoch, canonical report/digest, state/reason/audit timestamps | One promoted HNSW report per active project scope; FORCE RLS and cohort FK enforce authority boundaries. |
| `SangforFineTuneDataset` | `productCode`, `taskType`, `path`, `status` (default `draft`), `exampleCount` | JSONL dataset manifest (`data/finetune/*.jsonl`). |
| `SangforFineTuneJob` | `provider`, `baseModel`, `datasetPath`, `productCode`, `taskType`, `status` (default `ready_for_review`) | Fine-tune job spec; default status enforces human review. |

## Relations
- `SangforRagDocument 1—* SangforRagChunk` (via `SangforRagChunk.documentId`).

All other models are standalone. Migrations live in `prisma/migrations/`. Defaults encode policy: manuals start `needs_review`, fine-tune jobs start `ready_for_review` (nothing auto-trains), wiki proposals start `pending` (nothing auto-publishes).
