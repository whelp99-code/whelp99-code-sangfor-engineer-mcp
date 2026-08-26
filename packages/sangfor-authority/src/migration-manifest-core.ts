import { sourcesFor } from './migration-manifest-builder.js';
import {
  APPROVAL_REFS,
  AUDIT_REFS,
  EVIDENCE_REFS,
  IDENTITY_REFS,
  PROJECT_REFS,
  RAG_EMBEDDING_REFS,
  RAG_SOURCE_REFS,
  REGISTRY_REFS,
  RUNS_REFS,
} from './migration-inventory-core.js';

export const CORE_MIGRATIONS = [
  {
    id: 'm001-tenant-identity', order: 1, aggregate: 'tenant_identity', ownerPackage: '@sangfor/identity', classification: 'authoritative',
    sources: sourcesFor(IDENTITY_REFS), target: { kind: 'postgres', tables: ['BlroTenant', 'BlroActor', 'BlroRole', 'BlroProject'] },
    projectScope: 'not_applicable', rlsRequired: false, secretPolicy: 'digest_only', prerequisites: ['postgres-schema-v1'], dependsOn: [], inventoryRefs: [...IDENTITY_REFS],
  },
  {
    id: 'm002-project-installation-identity', order: 2, aggregate: 'project_installation_identity', ownerPackage: '@sangfor/identity', classification: 'authoritative',
    sources: sourcesFor(PROJECT_REFS), target: { kind: 'postgres', tables: [
      'BlroMembership', 'BlroClientEnrollment', 'BlroEnrollmentIdentity',
      'BlroEnrollmentCertificate', 'BlroEnrollmentGrant', 'BlroEnrollmentBootstrapToken',
      'BlroEnrollmentRotation', 'BlroAuthorityCutover', 'BlroAuthorityCutoverStaging',
      'BlroProjectAuthorityEpoch', 'BlroLocalWriteIntent', 'BlroSourceRootOwner',
    ] },
    projectScope: 'required', rlsRequired: true, secretPolicy: 'digest_only', prerequisites: ['rls-scope'], dependsOn: ['m001-tenant-identity'], inventoryRefs: [...PROJECT_REFS],
  },
  {
    id: 'm003-registry-services', order: 3, aggregate: 'registry_services', ownerPackage: '@sangfor/authority', classification: 'authoritative',
    sources: sourcesFor(REGISTRY_REFS), target: { kind: 'postgres', tables: ['BlroDevice', 'BlroServiceRegistry'] },
    projectScope: 'required', rlsRequired: true, secretPolicy: 'redact_before_authority', prerequisites: ['service-registry-schema'], dependsOn: ['m002-project-installation-identity'], inventoryRefs: [...REGISTRY_REFS],
  },
  {
    id: 'm004-runs-steps', order: 4, aggregate: 'runs_steps', ownerPackage: '@sangfor/runs', classification: 'authoritative',
    sources: sourcesFor(RUNS_REFS), target: { kind: 'postgres', tables: ['BlroRun', 'BlroRunStep'] },
    projectScope: 'required', rlsRequired: true, secretPolicy: 'redact_before_authority', prerequisites: ['run-payload-mask'], dependsOn: ['m002-project-installation-identity'], inventoryRefs: [...RUNS_REFS],
  },
  {
    id: 'm005-approvals-nonces', order: 5, aggregate: 'approvals_nonces', ownerPackage: '@sangfor/approval', classification: 'authoritative',
    sources: sourcesFor(APPROVAL_REFS), target: { kind: 'postgres', tables: ['BlroApproval', 'BlroApprovalNonce'] },
    projectScope: 'required', rlsRequired: true, secretPolicy: 'digest_only', prerequisites: ['approval-signature-secret'], dependsOn: ['m002-project-installation-identity'], inventoryRefs: [...APPROVAL_REFS],
  },
  {
    id: 'm006-audit', order: 6, aggregate: 'audit', ownerPackage: '@sangfor/audit', classification: 'authoritative',
    sources: sourcesFor(AUDIT_REFS), target: { kind: 'postgres', tables: ['BlroAuditEvent'] },
    projectScope: 'required', rlsRequired: true, secretPolicy: 'redact_before_authority', prerequisites: ['audit-hmac-secret'], dependsOn: ['m002-project-installation-identity', 'm004-runs-steps'], inventoryRefs: [...AUDIT_REFS],
  },
  {
    id: 'm007-evidence', order: 7, aggregate: 'evidence', ownerPackage: '@sangfor/evidence', classification: 'authoritative',
    sources: sourcesFor(EVIDENCE_REFS), target: { kind: 'postgres', tables: ['BlroEvidenceManifest'] },
    projectScope: 'required', rlsRequired: true, secretPolicy: 'redact_before_authority', prerequisites: ['object-store-receipt'], dependsOn: ['m004-runs-steps', 'm006-audit'], inventoryRefs: [...EVIDENCE_REFS],
  },
  {
    id: 'm008-rag-source-chunks', order: 8, aggregate: 'rag_source_chunks', ownerPackage: '@sangfor/rag', classification: 'authoritative',
    sources: sourcesFor(RAG_SOURCE_REFS), target: { kind: 'postgres', tables: ['BlroRagDocument', 'BlroRagSourceChunk'] },
    projectScope: 'required', rlsRequired: true, secretPolicy: 'redact_before_authority', prerequisites: ['rag-source-schema'], dependsOn: ['m002-project-installation-identity'], inventoryRefs: [...RAG_SOURCE_REFS],
  },
  {
    id: 'm009-rag-embeddings-local-index', order: 9, aggregate: 'rag_embeddings_local_index', ownerPackage: '@sangfor/rag', classification: 'derived',
    sources: sourcesFor(RAG_EMBEDDING_REFS), target: { kind: 'excluded' },
    projectScope: 'required', rlsRequired: false, secretPolicy: 'redact_before_authority', prerequisites: ['embedding-profile-version'], dependsOn: ['m008-rag-source-chunks'], inventoryRefs: [...RAG_EMBEDDING_REFS],
  },
] as const;
