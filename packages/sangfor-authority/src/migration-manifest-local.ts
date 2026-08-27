import { sourcesFor } from './migration-manifest-builder.js';
import { GENERATED_REFS } from './migration-inventory-generated.js';
import { RAG_PGVECTOR_REFS } from './migration-inventory-core.js';
import {
  ACQUISITION_REFS,
  BROWSER_JOB_AUTHORITY_REFS,
  CREDENTIAL_REFS,
  FINETUNE_REFS,
  IAG_REFS,
  JM_REFUSAL_JOURNAL_REFS,
  LEGACY_REFS,
  LOOP_REFS,
} from './migration-inventory-local.js';

export const LOCAL_AND_SEED_MIGRATIONS = [
  {
    id: 'm018-finetune-artifacts', order: 18, aggregate: 'finetune_artifacts', ownerPackage: '@sangfor/finetune', classification: 'derived',
    sources: sourcesFor(FINETUNE_REFS), target: { kind: 'excluded' }, projectScope: 'required', rlsRequired: false,
    secretPolicy: 'redact_before_authority', prerequisites: ['source-corpus'], dependsOn: ['m009-rag-embeddings-local-index'], inventoryRefs: [...FINETUNE_REFS],
  },
  {
    id: 'm019-browser-credentials', order: 19, aggregate: 'browser_credentials_private_keys', ownerPackage: '@sangfor/jm-execution', classification: 'credential_local',
    sources: sourcesFor(CREDENTIAL_REFS), target: { kind: 'excluded' }, projectScope: 'required', rlsRequired: false,
    secretPolicy: 'forbid', prerequisites: ['jm-os-keyring'], dependsOn: [], inventoryRefs: [...CREDENTIAL_REFS],
  },
  {
    id: 'm020-browser-job-authority', order: 20, aggregate: 'browser_job_authority', ownerPackage: '@sangfor/authority', classification: 'authoritative',
    sources: sourcesFor(BROWSER_JOB_AUTHORITY_REFS), target: { kind: 'postgres', tables: ['BlroRemoteJobCapabilityJti', 'BlroRemoteJob'] }, projectScope: 'required', rlsRequired: true,
    secretPolicy: 'digest_only', prerequisites: ['at-most-once-dispatch-tombstone'], dependsOn: ['m002-project-installation-identity'], inventoryRefs: [...BROWSER_JOB_AUTHORITY_REFS],
  },
  {
    id: 'm021-loop-runtime-cache', order: 21, aggregate: 'loop_runtime_cache', ownerPackage: '@sangfor/collector', classification: 'derived',
    sources: sourcesFor(LOOP_REFS), target: { kind: 'excluded' }, projectScope: 'required', rlsRequired: false,
    secretPolicy: 'redact_before_authority', prerequisites: ['bounded-retention'], dependsOn: ['m011-feedback-lessons'], inventoryRefs: [...LOOP_REFS],
  },
  {
    id: 'm022-acquisition-checkpoints', order: 22, aggregate: 'acquisition_checkpoints', ownerPackage: '@sangfor/collector', classification: 'derived',
    sources: sourcesFor(ACQUISITION_REFS), target: { kind: 'excluded' }, projectScope: 'not_applicable', rlsRequired: false,
    secretPolicy: 'redact_before_authority', prerequisites: ['source-redaction'], dependsOn: [], inventoryRefs: [...ACQUISITION_REFS],
  },
  {
    id: 'm023-iag-orchestrator-checkpoints', order: 23, aggregate: 'iag_orchestrator_checkpoints', ownerPackage: '@sangfor/product-adapters', classification: 'derived',
    sources: sourcesFor(IAG_REFS), target: { kind: 'excluded' }, projectScope: 'required', rlsRequired: false,
    secretPolicy: 'redact_before_authority', prerequisites: ['bounded-retention'], dependsOn: ['m004-runs-steps'], inventoryRefs: [...IAG_REFS],
  },
  {
    id: 'm024-legacy-unscoped-metadata', order: 24, aggregate: 'legacy_unscoped_metadata', ownerPackage: '@sangfor/authority', classification: 'derived',
    sources: sourcesFor(LEGACY_REFS), target: { kind: 'excluded' }, projectScope: 'not_applicable', rlsRequired: false,
    secretPolicy: 'redact_before_authority', prerequisites: ['legacy-read-only'], dependsOn: [], inventoryRefs: [...LEGACY_REFS],
  },
  {
    id: 'm025-generated-artifacts', order: 25, aggregate: 'generated_artifacts', ownerPackage: '@sangfor/collector', classification: 'derived',
    sources: sourcesFor(GENERATED_REFS), target: { kind: 'excluded' }, projectScope: 'not_applicable', rlsRequired: false,
    secretPolicy: 'redact_before_authority', prerequisites: ['disposable-output-policy'], dependsOn: [], inventoryRefs: [...GENERATED_REFS],
  },
  {
    id: 'm026-spec-registry', order: 26, aggregate: 'spec_registry', ownerPackage: '@sangfor-engineer/sangfor-spec', classification: 'curated_seed',
    sources: [{ path: 'data/specs', symbol: 'curated-seed:v1' }], target: { kind: 'source_only' }, projectScope: 'not_applicable', rlsRequired: false,
    secretPolicy: 'none', prerequisites: ['spec-review'], dependsOn: [], inventoryRefs: [],
  },
  {
    id: 'm027-jm-refusal-journal', order: 27, aggregate: 'jm_refusal_journal', ownerPackage: '@sangfor/jm-agent', classification: 'derived',
    sources: sourcesFor(JM_REFUSAL_JOURNAL_REFS), target: { kind: 'excluded' }, projectScope: 'required', rlsRequired: false,
    secretPolicy: 'forbid', prerequisites: ['signed-grant-genesis'], dependsOn: ['m002-project-installation-identity'], inventoryRefs: [...JM_REFUSAL_JOURNAL_REFS],
  },
  {
    id: 'm028-rag-embeddings-pgvector-index', order: 28, aggregate: 'rag_embeddings_pgvector_index', ownerPackage: '@sangfor/rag', classification: 'authoritative',
    sources: sourcesFor(RAG_PGVECTOR_REFS), target: { kind: 'postgres', tables: ['BlroRagEmbeddingCohort', 'BlroRagEmbedding'] },
    projectScope: 'required', rlsRequired: true, secretPolicy: 'redact_before_authority', prerequisites: ['pgvector-0.8.1', 'embedding-profile-version'], dependsOn: ['m008-rag-source-chunks'], inventoryRefs: [...RAG_PGVECTOR_REFS],
  },
] as const;
