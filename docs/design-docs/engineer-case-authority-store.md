# Decision: Engineer-case aggregate needs its own authority tables

**Status:** draft — E09A storage contract. Not an API, UI, or field-acceptance decision.

## Context

Issue #102 (E09A) must persist one engineer-case revision together with its
observation snapshot, requirement revision, guide digest, and artifact owner.
Existing BLRO aggregates were checked before adding tables:

| Existing target | Why it is not the case aggregate |
| --- | --- |
| `BlroRun` / `BlroRunStep` | Execution run ledger. A case is not a tool run and must not borrow run status. |
| `BlroEvidenceManifest` | Tied to `runId`. Case evidence is owned by tenant/project/case, not a run. |
| `BlroRagDocument` / chunks / embeddings | Public or project search index. Confidential case originals must not be indexed here. |
| Domain records (`BlroPmRecord`, chronicle, evals, …) | Other aggregates. Reusing them would hide case concurrency and scope rules. |

## Decision

Add two FORCE-RLS tables written only by `BlroAuthorityStore`:

- `BlroEngineerCase` — one durable row per case id, optimistic `revision`,
  idempotent `requestId`/`requestDigest`, and the assembled document.
- `BlroEngineerCaseArtifact` — confidential artifact bytes owned by the case,
  committed in the same transaction.

There is no local-file or RAG fallback. A failed transaction is `unsaved` and
is not resumable or approvable. Process restart reads the same Postgres row.

## Rationale

- Atomic case + artifact commit is a database transaction, not two stores.
- Optimistic concurrency is a row `revision` compare, not a file lock.
- Search-index tables cannot hold unsanitized originals.

## Consequences

- Additive migration only. Production apply stays a BLRO operation.
- API/UI resume is E09B. This PR is the store contract and writer.
- Cutover policy is PostgreSQL-native: there is no legacy case file source.
