import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  parseBoundarySharedJsonlRecordV1,
  type NamedRuntimeCodec,
} from './runtime-schema.js';

export {
  assertNoLocalSafetyMarker,
  explicitLocalPrimaryAuthority,
  expectedLocalWriteScope,
  localSafetyMarkerPath,
  localSourceRootIdentity,
  normalizeLocalWriteIntent,
  requireLocalWriteAuthority,
  resolveProductionLocalWriteAuthority,
  type LocalWriteAuthority,
  type LocalWriteExpectedScope,
  type LocalWriteFencePort,
  type LocalWriteIntent,
  type LocalWriteIntentInput,
  type LocalWriteScope,
} from './local-write-fence.js';

export {
  CanonicalOriginError,
  canonicalizeUrlOrigin,
  digestCanonicalOrigin,
  type CanonicalOriginInput,
} from './origin.js';

export {
  assertBindSafety,
  checkAuth,
  isLoopback,
  resolveBindHost,
} from './http-exposure.js';

export {
  activeEngagementId,
  resolveEngagementScopedData,
  resolveRepoData,
} from './repo-data.js';

export {
  DirLockTimeoutError,
  withDirLock,
  writeFileAtomicSync,
} from './atomic-io.js';

export {
  PRODUCTS,
  PRODUCT_PRIORITY,
  normalizeProduct,
  type ProductCode,
  type SangforProduct,
} from './product-catalog.js';

export {
  type ApprovalDecision,
  type ApprovalStatus,
  type ConfigPlan,
  type ConfigStep,
  type ConsoleAction,
  type ConsoleActionResult,
  type KnowledgeChunk,
  type ProjectAnalysis,
  type ProjectInput,
  type ProjectType,
  type RiskLevel,
} from './contracts.js';

export { containsSensitiveLearningTopic } from './learning-mask.js';
export { nowId } from './identifiers.js';

export function appendJsonl<T extends { id: string }>(path: string, record: T): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`);
}

export function foldJsonlById<T extends { id: string }>(
  path: string,
  codec: NamedRuntimeCodec<T>,
): Map<string, T> {
  const byId = new Map<string, T>();
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return byId;
    throw error;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const record = parseBoundarySharedJsonlRecordV1(trimmed, codec);
    byId.set(record.id, record);
  }
  return byId;
}

export {
  decodeCursor,
  encodeCursor,
  paginate,
  type PaginateOptions,
  type PaginateResult,
} from './pagination.js';
