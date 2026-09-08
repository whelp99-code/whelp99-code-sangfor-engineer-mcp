import { z } from 'zod';
import { runtimeJsonObjectSchema } from '../../shared/src/runtime-json-codecs.js';
import {
  parseRuntimeJson,
  type NamedRuntimeCodec,
  type RuntimeCodec,
} from '../../shared/src/runtime-schema.js';
import {
  evaluationResultRuntimeSchema,
  intendedSpecRuntimeSchema,
} from '../../sangfor-spec/src/runtime-boundaries.js';
import type { EvaluationResult } from '../../sangfor-spec/src/index.js';
import type { GoldenFixture } from './golden.js';
import type { EngineerReport, EngineerReportRecord } from './report.js';

const idSchema = z.string().min(1).max(512);
const textSchema = z.string().max(16 * 1024 * 1024);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const timestampSchema = z.string().min(1).max(128);
const citationSchema = z.object({
  chunkId: idSchema,
  filePath: z.string().min(1).max(16_384),
}).strict();

const engineerReportSchema: RuntimeCodec<EngineerReport> = z.object({
  schemaVersion: z.literal(1),
  reportId: idSchema,
  deviceId: idSchema,
  snapshotHash: hashSchema,
  engineResult: evaluationResultRuntimeSchema,
  riskNote: textSchema,
  recommendations: z.array(textSchema).max(100_000),
  rollbackPlan: z.array(textSchema).max(100_000),
  ragCitations: z.array(citationSchema).max(100_000),
  modelId: idSchema,
  promptHash: hashSchema,
  createdAt: timestampSchema,
}).strict();

const reportRecordSchema: RuntimeCodec<EngineerReportRecord> = z.object({
  seq: z.number().int().positive(),
  prevHash: z.union([z.literal('GENESIS'), hashSchema]),
  hash: hashSchema,
  report: engineerReportSchema,
}).strict();

const goldenFixtureSchema: RuntimeCodec<GoldenFixture> = z.object({
  vendor: z.enum(['fortios', 'cisco']),
  firmware: z.string().min(1).max(256),
  rawPayload: runtimeJsonObjectSchema,
  allowlist: z.array(idSchema).max(100_000),
  expectedObserved: runtimeJsonObjectSchema,
  spec: intendedSpecRuntimeSchema,
  evaluatedAt: timestampSchema,
  expectedVerdicts: z.record(idSchema, z.enum(['PASS', 'FAIL', 'INDETERMINATE'])),
}).strict();

export function parseBoundaryEngineerCanonicalCloneV1<TOutput, TInput>(
  source: string,
  codec: NamedRuntimeCodec<TOutput, TInput>,
): TOutput {
  return parseRuntimeJson(source, {
    ...codec,
    schemaName: 'engineer-report.canonical-clone.v1',
    policy: 'loud_failure',
  });
}

export function parseBoundaryEngineerGoldenFixtureV1(source: string): GoldenFixture {
  return parseRuntimeJson(source, {
    schema: goldenFixtureSchema,
    schemaName: 'engineer-report.golden-fixture.v1',
    policy: 'invalid_report',
    uniqueIdCollectionPath: ['spec', 'items'],
  });
}

export function parseBoundaryEngineerReportLineV1(source: string): EngineerReportRecord {
  return parseRuntimeJson(source, {
    schema: reportRecordSchema,
    schemaName: 'engineer-report.ledger-line.v1',
    policy: 'invalid_report',
    expectedVersion: 1,
    versionPath: ['report', 'schemaVersion'],
  });
}

export function parseBoundaryEngineerEvaluationCloneV1(source: string): EvaluationResult {
  return parseRuntimeJson(source, {
    schema: evaluationResultRuntimeSchema,
    schemaName: 'engineer-report.evaluation-result.v1',
    policy: 'loud_failure',
    uniqueIdCollectionPath: ['items'],
  });
}
