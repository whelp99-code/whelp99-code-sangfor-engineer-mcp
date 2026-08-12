export const AUTHORITY_MIGRATIONS = [
  { aggregate: 'device_registry', supersededLocalStore: 'data/registry/devices.json', authoritativeWriter: 'BlroAuthorityStore', jmTreatment: 'derived bounded execution snapshot' },
  { aggregate: 'run_step', supersededLocalStore: 'data/runs/*.jsonl', authoritativeWriter: 'BlroAuthorityStore', jmTreatment: 'disposable active-job cache' },
  { aggregate: 'approval', supersededLocalStore: 'in-memory Control Tower approval state', authoritativeWriter: 'BlroAuthorityStore', jmTreatment: 'none; presented capability only' },
  { aggregate: 'approval_nonce', supersededLocalStore: 'data/runtime/approval-nonces.json', authoritativeWriter: 'PostgresSingleUseNonceStore', jmTreatment: 'none; consume centrally' },
  { aggregate: 'audit_chain', supersededLocalStore: 'data/evidence/change-runs/*.jsonl', authoritativeWriter: 'BlroAuthorityStore', jmTreatment: 'temporary delivery buffer until acknowledged' },
  { aggregate: 'evidence_manifest', supersededLocalStore: 'data/evidence manifests and capture ledgers', authoritativeWriter: 'BlroAuthorityStore', jmTreatment: 'temporary bytes plus upload receipt' },
  { aggregate: 'rag_document_chunk', supersededLocalStore: 'data/rag/index.json', authoritativeWriter: 'BlroAuthorityStore', jmTreatment: 'derived disposable encrypted cache' },
] as const;

export type AuthorityAggregate = (typeof AUTHORITY_MIGRATIONS)[number]['aggregate'];
