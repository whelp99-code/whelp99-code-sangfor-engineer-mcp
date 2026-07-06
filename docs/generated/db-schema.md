# Database Schema (generated)

- **Source:** `prisma/schema.prisma` (`provider = postgresql`, `url = env("DATABASE_URL")`)
- **Generated:** 2026-07-04 — regenerate by hand from the schema when models change (or `pnpm run db:generate` for the client).
- **Status:** This Postgres schema is an **optional persistence bridge** (`@sangfor/store`, active only when `DATABASE_URL` is set and `SANGFOR_DB_ENABLED != 0`). It is **not** the primary datastore — primary state is file-based under `data/` (see [ARCHITECTURE.md → Persistence](../../ARCHITECTURE.md#persistence)).

## Models

| Model | Key fields | Notes |
|---|---|---|
| `SangforProduct` | `code @unique`, `name`, `priority`, `enabled` | Product catalog (mirrors `@sangfor/shared` `PRODUCTS`). |
| `SangforManual` | `product`, `version?`, `title`, `sourceType`, `sourceUrl?`, `filePath?`, `trustLevel` (default `needs_review`) | Ingested manual metadata. |
| `SangforProject` | `customerName`, `product`, `projectType`, `status` (default `draft`) | Engagement/project record. |
| `SangforConfigPlan` | `projectId?`, `product`, `planTitle`, `planJson` (Json), `riskLevel`, `status` | Persisted planner output (`persistConfigPlan`). |
| `SangforFeedbackEvent` | `product`, `feedbackType`, `severity`, `feedbackText`, `sourceRole`, `status` (default `new`) | Feedback capture (`persistFeedbackEvent`); in-app source is currently in-memory. |
| `SangforWikiUpdateProposal` | `targetPage`, `title`, `beforeText`, `afterText`, `status` (default `pending`) | Review-gated wiki proposal. |
| `SangforRagDocument` | `productCode`, `version?`, `title`, `sourceType`, `filePath`, `contentHash @unique`, → `chunks` | Mirror of a `data/rag/index.json` document (`upsertRagDocumentMeta`). |
| `SangforRagChunk` | `documentId` → `SangforRagDocument`, `productCode`, `section?`, `chunkText`, `vector Json?`, `contentHash @unique` | Vectors stored as JSON; **no pgvector** — search is the in-process cosine scan over the local index. |
| `SangforFineTuneDataset` | `productCode`, `taskType`, `path`, `status` (default `draft`), `exampleCount` | JSONL dataset manifest (`data/finetune/*.jsonl`). |
| `SangforFineTuneJob` | `provider`, `baseModel`, `datasetPath`, `productCode`, `taskType`, `status` (default `ready_for_review`) | Fine-tune job spec; default status enforces human review. |

## Relations
- `SangforRagDocument 1—* SangforRagChunk` (via `SangforRagChunk.documentId`).

All other models are standalone. Migrations live in `prisma/migrations/`. Defaults encode policy: manuals start `needs_review`, fine-tune jobs start `ready_for_review` (nothing auto-trains), wiki proposals start `pending` (nothing auto-publishes).
