import { z } from 'zod';
import { AUTHORITY_MANIFEST, type AuthorityAggregate } from '../migration-manifest.js';
import { AuthorityCutoverError } from './errors.js';

const policySchema = z.object({
  aggregate: z.string(),
  policy: z.enum(['backfill', 'invalidate_on_cutover', 'postgres_native']),
  sourceInventoryRefs: z.array(z.string()).readonly(),
  targetTables: z.array(z.string()).min(1).readonly(),
  rationale: z.string().min(1),
}).strict().readonly();
export type AuthorityAdapterPolicy = z.infer<typeof policySchema> & { readonly aggregate: AuthorityAggregate };

const BACKFILL = new Set<AuthorityAggregate>([
  'registry_services', 'runs_steps', 'audit', 'evidence', 'pm_tasks',
  'feedback_lessons', 'evals', 'wiki_proposals', 'learning_strategy_lifecycle',
  'config_chronicle_state', 'capability_evidence_promotion',
]);
const INVALIDATE = new Set<AuthorityAggregate>(['approvals_nonces', 'browser_job_authority']);
const RATIONALES: Readonly<Record<string, string>> = {
  tenant_identity: 'Tenant and actor identities are provisioned in PostgreSQL before project cutover.',
  project_installation_identity: 'Enrollment and cutover coordination are already PostgreSQL-native.',
  registry_services: 'Legacy registry and playbook files contain authoritative device and service records.',
  runs_steps: 'Legacy run and analysis JSONL files contain authoritative execution history.',
  approvals_nonces: 'Old approval and nonce capabilities must be spent, never copied.',
  audit: 'Local change-run chains must retain exact sequence and hashes.',
  evidence: 'Local engineer-report manifests must retain content and provenance.',
  rag_source_chunks: 'Authoritative source chunks are project-scoped PostgreSQL rows.',
  rag_embeddings_local_index: 'The legacy JSON embedding index remains classified as derived and is never an authority fallback.',
  rag_embeddings_pgvector_index: 'Todo33 makes cohort metadata and pgvector embeddings PostgreSQL-native; local JSON is neither source nor fallback.',
  pm_tasks: 'Legacy agent-task files contain authoritative PM work state.',
  feedback_lessons: 'Legacy feedback and lesson JSONL records are authoritative.',
  evals: 'Feedback-derived eval JSONL records are authoritative.',
  wiki_proposals: 'Legacy proposals and knowledge-card records are authoritative.',
  learning_strategy_lifecycle: 'Strategy generation and lifecycle files are authoritative.',
  firmware_version_evidence: 'Firmware authority is already represented by PostgreSQL mirror evidence.',
  config_chronicle_state: 'Local content-addressed chronicle chains are authoritative.',
  capability_evidence_promotion: 'Promotion ledger and checkpoint chains are authoritative.',
  browser_job_authority: 'Outstanding remote-job capabilities must become indeterminate, never copied.',
};

function localRefs(refs: readonly string[]): readonly string[] {
  return refs.filter((reference) => reference.startsWith('persist:')
    && !reference.startsWith('persist:packages/sangfor-authority/')
    && !reference.includes('postgres-nonce-store.ts')
    && !reference.startsWith('persist:packages/sangfor-rag/src/pgvector-store.ts#'));
}

const RAW_POLICIES = AUTHORITY_MANIFEST.entries
  .filter((entry) => entry.classification === 'authoritative')
  .map((entry) => {
    if (entry.target.kind !== 'postgres') throw new AuthorityCutoverError('CUTOVER_POLICY_TARGET_INVALID');
    const policy = BACKFILL.has(entry.aggregate)
      ? 'backfill' as const
      : INVALIDATE.has(entry.aggregate) ? 'invalidate_on_cutover' as const : 'postgres_native' as const;
    return {
      aggregate: entry.aggregate,
      policy,
      sourceInventoryRefs: policy === 'postgres_native' ? [] : localRefs(entry.inventoryRefs),
      targetTables: [...entry.target.tables],
      rationale: RATIONALES[entry.aggregate] ?? '',
    };
  });

export function parseAuthorityAdapterRegistry(input: unknown): readonly AuthorityAdapterPolicy[] {
  const parsed = z.array(policySchema).safeParse(input);
  if (!parsed.success) throw new AuthorityCutoverError('CUTOVER_POLICY_INVALID', [], { cause: parsed.error });
  const authoritative = AUTHORITY_MANIFEST.entries.filter((entry) => entry.classification === 'authoritative');
  const byAggregate = new Map(parsed.data.map((entry) => [entry.aggregate, entry]));
  if (byAggregate.size !== parsed.data.length || byAggregate.size !== authoritative.length) {
    throw new AuthorityCutoverError('CUTOVER_POLICY_SET_MISMATCH');
  }
  for (const manifest of authoritative) {
    const policy = byAggregate.get(manifest.aggregate);
    if (!policy || manifest.target.kind !== 'postgres') throw new AuthorityCutoverError('CUTOVER_POLICY_SET_MISMATCH');
    if ([...policy.targetTables].sort().join('\0') !== [...manifest.target.tables].sort().join('\0')) {
      throw new AuthorityCutoverError('CUTOVER_POLICY_TARGET_MISMATCH', [manifest.aggregate]);
    }
    const locals = localRefs(manifest.inventoryRefs);
    if (policy.policy === 'backfill' && locals.length === 0) throw new AuthorityCutoverError('CUTOVER_POLICY_SOURCE_MISSING');
    if (policy.policy === 'postgres_native' && (locals.length > 0 || policy.sourceInventoryRefs.length > 0)) {
      throw new AuthorityCutoverError('CUTOVER_NATIVE_SOURCE_FORBIDDEN');
    }
    if (policy.policy !== 'postgres_native') {
      const expected = [...localRefs(manifest.inventoryRefs)].sort();
      if ([...policy.sourceInventoryRefs].sort().join('\0') !== expected.join('\0')) {
        throw new AuthorityCutoverError('CUTOVER_POLICY_SOURCE_MISMATCH', [manifest.aggregate]);
      }
    }
  }
  return parsed.data.map((entry) => {
    const manifest = authoritative.find((candidate) => candidate.aggregate === entry.aggregate);
    if (!manifest) throw new AuthorityCutoverError('CUTOVER_POLICY_UNKNOWN');
    return { ...entry, aggregate: manifest.aggregate };
  });
}

export const AUTHORITY_ADAPTER_POLICIES = parseAuthorityAdapterRegistry(RAW_POLICIES);
