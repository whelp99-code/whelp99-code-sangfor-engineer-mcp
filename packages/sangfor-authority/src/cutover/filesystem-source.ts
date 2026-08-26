import { createHash, createHmac } from 'node:crypto';
import { basename } from 'node:path';
import type { AuthorityAggregate } from '../migration-manifest.js';
import { AUTHORITY_ADAPTER_POLICIES } from './adapter-policy.js';
import { AuthorityCutoverError } from './errors.js';
import { canonicalJson } from './records.js';
import { filesBelow, parseJsonFile, parseJsonLines, parseJsonSingle, sourceSnapshot } from './source-files.js';
import {
  agentTaskSchema, analysisSchema, auditSchema, chronicleSchema, deviceSchema, engineerReportRecordSchema,
  evalSchema, feedbackSchema, learningGenerationSchema, learningSchema, playbookSchema, promotionCheckpointSchema,
  promotionEventSchema, runSchema, vendorSchema, wikiSchema,
} from './source-schemas.js';
import type { CutoverRecord, CutoverSourceAdapter } from './types.js';

export type FilesystemSourceOptions = {
  readonly aggregate: AuthorityAggregate;
  readonly tenantId: string;
  readonly sourceRoot: string;
  readonly expectedFiles: readonly string[];
  readonly auditSecret?: string;
  readonly promotionLedgerSecret?: string;
  readonly promotionCheckpointSecret?: string;
};

function groupBySource(records: readonly CutoverRecord[]): ReadonlyMap<string, readonly CutoverRecord[]> {
  const grouped = new Map<string, CutoverRecord[]>();
  for (const record of records) grouped.set(record.provenance.source, [...(grouped.get(record.provenance.source) ?? []), record]);
  return grouped;
}

function assertUniqueKeys(records: readonly CutoverRecord[]): readonly CutoverRecord[] {
  const keys = new Set<string>();
  for (const record of records) {
    if (keys.has(record.key)) throw new AuthorityCutoverError('CUTOVER_SOURCE_DUPLICATE_KEY', [record.key]);
    keys.add(record.key);
  }
  return records;
}

function verifyAudit(records: readonly CutoverRecord[], secret?: string): void {
  const bySource = groupBySource(records);
  for (const chain of bySource.values()) {
    let previous = 'GENESIS';
    for (const [index, record] of [...chain].sort((left, right) => left.provenance.ordinal - right.provenance.ordinal).entries()) {
      const payload = record.payload;
      const seq = payload['seq']; const kind = payload['kind']; const body = payload['payload'];
      if (seq !== index || payload['prevHash'] !== previous || typeof kind !== 'string') throw new AuthorityCutoverError('CUTOVER_CHAIN_GAP');
      const material = `${previous}\n${seq}\n${kind}\n${JSON.stringify(body)}`;
      const keyed = payload['keyed'] === true;
      if (keyed && !secret) throw new AuthorityCutoverError('CUTOVER_AUDIT_SECRET_REQUIRED');
      const hash = keyed
        ? createHmac('sha256', secret ?? '').update(material).digest('hex')
        : createHash('sha256').update(material).digest('hex');
      if (payload['hash'] !== hash) throw new AuthorityCutoverError('CUTOVER_CHAIN_TAMPERED');
      previous = hash;
    }
  }
}

function verifyReports(records: readonly CutoverRecord[]): void {
  const bySource = groupBySource(records);
  for (const chain of bySource.values()) {
    let previous = 'GENESIS';
    for (const [index, record] of [...chain].sort((left, right) => left.provenance.ordinal - right.provenance.ordinal).entries()) {
      const payload = record.payload;
      if (payload['seq'] !== index + 1 || payload['prevHash'] !== previous) throw new AuthorityCutoverError('CUTOVER_CHAIN_GAP');
      const report = payload['report'];
      const hash = createHash('sha256').update(`${previous}|${canonicalJson(report)}`).digest('hex');
      if (payload['hash'] !== hash) throw new AuthorityCutoverError('CUTOVER_CHAIN_TAMPERED');
      previous = hash;
    }
  }
}

function verifyChronicle(records: readonly CutoverRecord[]): void {
  for (const record of records) {
    const snapshots = record.payload['snapshots'];
    if (!Array.isArray(snapshots)) throw new AuthorityCutoverError('CUTOVER_SOURCE_INVALID');
    let previous: string | undefined;
    for (const snapshot of snapshots) {
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new AuthorityCutoverError('CUTOVER_SOURCE_INVALID');
      const value = snapshot as Readonly<Record<string, unknown>>;
      if (value['parentHash'] !== previous || typeof value['canonical'] !== 'string') throw new AuthorityCutoverError('CUTOVER_CHAIN_GAP');
      const hash = createHash('sha256').update(value['canonical']).digest('hex');
      if (value['hash'] !== hash) throw new AuthorityCutoverError('CUTOVER_CHAIN_TAMPERED');
      previous = hash;
    }
    if (record.payload['headHash'] !== previous && snapshots.length > 0) throw new AuthorityCutoverError('CUTOVER_CHAIN_GAP');
  }
}

function verifyLearning(records: readonly CutoverRecord[]): void {
  for (const record of records) {
    const generations = record.payload['generations'];
    if (!Array.isArray(generations) || record.payload['currentGeneration'] !== generations.length) {
      throw new AuthorityCutoverError('CUTOVER_GENERATION_GAP');
    }
    for (const [index, generation] of generations.entries()) {
      const parsed = learningGenerationSchema.safeParse(generation);
      if (!parsed.success) throw new AuthorityCutoverError('CUTOVER_SOURCE_INVALID', [], { cause: parsed.error });
      if (parsed.data.generation !== index + 1) throw new AuthorityCutoverError('CUTOVER_GENERATION_GAP');
      const keys = Object.keys(parsed.data.revisions[0] ?? {}).sort();
      const hash = createHash('sha256').update(JSON.stringify(parsed.data.revisions, keys)).digest('hex');
      if (parsed.data.contentHash !== hash) throw new AuthorityCutoverError('CUTOVER_GENERATION_TAMPERED');
    }
  }
}

function verifyPromotion(records: readonly CutoverRecord[], secret?: string, checkpointSecret?: string): void {
  const ledgerRecords = records.filter((record) => record.provenance.source.endsWith('.jsonl'));
  const checkpoint = records.find((record) => record.provenance.source.endsWith('.head.json'));
  if (ledgerRecords.length > 0 && !secret) throw new AuthorityCutoverError('CUTOVER_PROMOTION_SECRET_REQUIRED');
  for (const chain of groupBySource(ledgerRecords).values()) {
    let previous = 'GENESIS';
    for (const [index, record] of [...chain].sort((left, right) => left.provenance.ordinal - right.provenance.ordinal).entries()) {
      const { hash, ...unsigned } = record.payload;
      if (record.payload['seq'] !== index || record.payload['prevHash'] !== previous) throw new AuthorityCutoverError('CUTOVER_CHAIN_GAP');
      const expected = createHmac('sha256', secret ?? '')
        .update(`sangfor.capability-promotion-ledger.v1\n${canonicalJson(unsigned)}`, 'utf8').digest('hex');
      if (hash !== expected) throw new AuthorityCutoverError('CUTOVER_CHAIN_TAMPERED');
      previous = expected;
    }
  }
  if (!checkpoint || !checkpointSecret) throw new AuthorityCutoverError('CUTOVER_PROMOTION_CHECKPOINT_SECRET_REQUIRED');
  const count = checkpoint.payload['eventCount']; const lastHash = checkpoint.payload['lastHash'];
  if (count !== ledgerRecords.length || lastHash !== (ledgerRecords.at(-1)?.payload['hash'] ?? 'GENESIS')) {
    throw new AuthorityCutoverError('CUTOVER_PROMOTION_CHECKPOINT_MISMATCH');
  }
  const expectedHmac = createHmac('sha256', checkpointSecret)
    .update(`sangfor.capability-promotion-checkpoint.v1\n1\n${count}\n${lastHash}`, 'utf8').digest('hex');
  if (checkpoint.payload['hmac'] !== expectedHmac) throw new AuthorityCutoverError('CUTOVER_PROMOTION_CHECKPOINT_TAMPERED');
}

export class FilesystemCutoverSourceAdapter implements CutoverSourceAdapter {
  readonly aggregate: AuthorityAggregate;
  constructor(private readonly options: FilesystemSourceOptions) {
    this.aggregate = options.aggregate;
    const policy = AUTHORITY_ADAPTER_POLICIES.find((entry) => entry.aggregate === options.aggregate);
    if (policy?.policy !== 'backfill') throw new AuthorityCutoverError('CUTOVER_SOURCE_POLICY_INVALID');
  }

  async capture(projectId: string) {
    const files = filesBelow(this.options.sourceRoot, (path) => !path.startsWith('.blro-authority/'));
    const actual = files.map((file) => file.relativePath).sort();
    if (this.options.expectedFiles.some((path) => path.startsWith('/') || path.split(/[\\/]/u).some((part) => part === '..' || part === '.'))) {
      throw new AuthorityCutoverError('CUTOVER_SOURCE_PATH_TRAVERSAL');
    }
    const expected = [...new Set(this.options.expectedFiles)].sort();
    if (expected.length !== this.options.expectedFiles.length || actual.join('\n') !== expected.join('\n')) {
      throw new AuthorityCutoverError('CUTOVER_SOURCE_FILE_SET_MISMATCH', [...actual, '--EXPECTED--', ...expected]);
    }
    if (files.some((file) => !this.accept(file.relativePath))) throw new AuthorityCutoverError('CUTOVER_SOURCE_NATIVE_FILE_INVALID');
    this.requireNativeFiles(actual);
    const binding = { tenantId: this.options.tenantId, projectId, sourceRoot: this.options.sourceRoot };
    let records = files.flatMap((file) => this.parse(file, binding));
    records = [...assertUniqueKeys(records)];
    if (this.aggregate === 'audit') verifyAudit(records, this.options.auditSecret);
    if (this.aggregate === 'evidence') verifyReports(records);
    if (this.aggregate === 'learning_strategy_lifecycle') verifyLearning(records);
    if (this.aggregate === 'config_chronicle_state') verifyChronicle(records);
    if (this.aggregate === 'capability_evidence_promotion') {
      verifyPromotion(records, this.options.promotionLedgerSecret, this.options.promotionCheckpointSecret);
    }
    return sourceSnapshot(records);
  }

  private requireNativeFiles(paths: readonly string[]): void {
    const basenames = new Set(paths.map((path) => basename(path)));
    const required = this.aggregate === 'registry_services' ? ['vendors.json', 'devices.json', 'playbooks.json']
      : this.aggregate === 'feedback_lessons' ? ['feedback.jsonl', 'lessons.jsonl']
        : this.aggregate === 'wiki_proposals' ? ['proposals.jsonl', 'knowledge-cards.jsonl'] : [];
    if (required.some((name) => !basenames.has(name))) throw new AuthorityCutoverError('CUTOVER_SOURCE_NATIVE_FILE_MISSING', required);
    if (this.aggregate === 'capability_evidence_promotion') {
      const ledgers = paths.filter((path) => path.endsWith('.jsonl'));
      if (ledgers.length !== 1 || !paths.includes(`${ledgers[0]}.head.json`)) {
        throw new AuthorityCutoverError('CUTOVER_SOURCE_NATIVE_FILE_MISSING');
      }
    }
  }

  private accept(path: string): boolean {
    switch (this.aggregate) {
      case 'registry_services': return /^(?:data\/registry\/)?(devices|playbooks|vendors)\.json$/u.test(path);
      case 'runs_steps': return path.endsWith('.jsonl') && (!path.startsWith('data/') || path.startsWith('data/runs/'));
      case 'audit': return path.endsWith('.jsonl') && (!path.startsWith('data/') || path.startsWith('data/evidence/change-runs/')); 
      case 'evidence': return basename(path) === 'engineer-reports.jsonl';
      case 'pm_tasks': return /^(?:data\/registry\/)?agent-tasks\.json$/u.test(path);
      case 'feedback_lessons': return path.endsWith('.jsonl') && (!path.startsWith('data/') || path.startsWith('data/feedback/'));
      case 'evals': return /^(?:data\/evals\/)?eval-cases\.jsonl$/u.test(path);
      case 'wiki_proposals': return path.endsWith('.jsonl') && (!path.startsWith('data/') || path.startsWith('data/wiki/'));
      case 'learning_strategy_lifecycle': return path.endsWith('.json') && (!path.includes('/') || path.startsWith('data/runtime/learning-strategies/'));
      case 'config_chronicle_state': return path.endsWith('.json') && (!path.includes('/') || path.startsWith('data/runtime/chronicle/'));
      case 'capability_evidence_promotion': return (path.endsWith('.jsonl') || path.endsWith('.head.json'))
        && (!path.includes('/') || path.startsWith('data/runtime/capability-promotion/')); 
      default: throw new AuthorityCutoverError('CUTOVER_SOURCE_POLICY_INVALID');
    }
  }

  private parse(file: Parameters<typeof parseJsonLines>[0], binding: Parameters<typeof parseJsonLines>[2]): readonly CutoverRecord[] {
    switch (this.aggregate) {
      case 'registry_services': return parseJsonFile(file,
        file.relativePath.endsWith('devices.json') ? deviceSchema.array()
          : file.relativePath.endsWith('vendors.json') ? vendorSchema.array() : playbookSchema.array(), binding);
      case 'runs_steps': return parseJsonLines(file, file.relativePath.includes('analyses/') ? analysisSchema : runSchema, binding);
      case 'audit': return parseJsonLines(file, auditSchema, binding);
      case 'evidence': return parseJsonLines(file, engineerReportRecordSchema, binding);
      case 'pm_tasks': return parseJsonFile(file, agentTaskSchema.array(), binding);
      case 'feedback_lessons': return parseJsonLines(file, feedbackSchema, binding);
      case 'evals': return parseJsonLines(file, evalSchema, binding);
      case 'wiki_proposals': return parseJsonLines(file, wikiSchema, binding);
      case 'learning_strategy_lifecycle': return parseJsonSingle(file, learningSchema, binding);
      case 'config_chronicle_state': return parseJsonSingle(file, chronicleSchema, binding);
      case 'capability_evidence_promotion': return file.relativePath.endsWith('.head.json')
        ? parseJsonSingle(file, promotionCheckpointSchema, binding) : parseJsonLines(file, promotionEventSchema, binding);
      default: throw new AuthorityCutoverError('CUTOVER_SOURCE_POLICY_INVALID');
    }
  }
}
