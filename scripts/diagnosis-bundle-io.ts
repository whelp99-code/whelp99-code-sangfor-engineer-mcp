import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  captureKeyringFromEnv,
  promoteCapturePayload,
  readCaptureBundle,
  readCapturePayload,
  type CaptureBundleSummary,
  type CaptureKeyring,
} from '../packages/sangfor-collector/src/capture-bundle.js';
import {
  mapCcPoolToConfigState,
  mapEppPoolToConfigState,
  type ObservedFactJson,
} from '../packages/sangfor-config-state/src/index.js';

export const DIAGNOSIS_CAPTURE_KIND = 'diagnosis-config-state.v1' as const;
export type DiagnosisProduct = 'EPP' | 'CC' | 'IAG';

export interface DiagnosisCapturePayload {
  kind: typeof DIAGNOSIS_CAPTURE_KIND;
  product: DiagnosisProduct;
  firmwareVersion: string;
  collectedAt: string;
  endpointsCaptured: number;
  observed: Record<string, ObservedFactJson>;
}

const DEFAULT_VERSIONS: Record<DiagnosisProduct, string> = {
  EPP: '6.0.4',
  CC: '3.0.98',
  IAG: '13.0.120',
};

export function createDiagnosisCapturePayload(
  product: DiagnosisProduct,
  pool: Record<string, unknown>,
  collectedAt = new Date(),
): DiagnosisCapturePayload {
  if (!Number.isFinite(collectedAt.getTime())) throw new Error('INVALID_DIAGNOSIS_CAPTURE: collectedAt is invalid.');
  if (product === 'EPP') {
    const mapped = mapEppPoolToConfigState(pool, { collector: 'capture-bundle.v1' });
    return { kind: DIAGNOSIS_CAPTURE_KIND, product, firmwareVersion: DEFAULT_VERSIONS.EPP,
      collectedAt: collectedAt.toISOString(), endpointsCaptured: mapped.endpointsCaptured, observed: mapped.observed };
  }
  if (product === 'CC') {
    const mapped = mapCcPoolToConfigState(pool, { collector: 'capture-bundle.v1' });
    return { kind: DIAGNOSIS_CAPTURE_KIND, product, firmwareVersion: DEFAULT_VERSIONS.CC,
      collectedAt: collectedAt.toISOString(), endpointsCaptured: mapped.endpointsCaptured, observed: mapped.observed };
  }
  return { kind: DIAGNOSIS_CAPTURE_KIND, product, firmwareVersion: DEFAULT_VERSIONS.IAG,
    collectedAt: collectedAt.toISOString(), endpointsCaptured: Object.keys(pool).length, observed: {} };
}

export function validateDiagnosisCapturePayload(input: unknown, expectedProduct?: DiagnosisProduct): DiagnosisCapturePayload {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_DIAGNOSIS_CAPTURE: payload must be an object.');
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['collectedAt', 'endpointsCaptured', 'firmwareVersion', 'kind', 'observed', 'product'])) {
    throw new Error('INVALID_DIAGNOSIS_CAPTURE: payload contains missing or unknown keys.');
  }
  if (record.kind !== DIAGNOSIS_CAPTURE_KIND || !['EPP', 'CC', 'IAG'].includes(String(record.product))
    || (expectedProduct !== undefined && record.product !== expectedProduct)
    || typeof record.firmwareVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u.test(record.firmwareVersion)
    || typeof record.collectedAt !== 'string' || new Date(record.collectedAt).toISOString() !== record.collectedAt
    || typeof record.endpointsCaptured !== 'number' || !Number.isSafeInteger(record.endpointsCaptured) || record.endpointsCaptured < 0
    || !record.observed || typeof record.observed !== 'object' || Array.isArray(record.observed)) {
    throw new Error('INVALID_DIAGNOSIS_CAPTURE: payload fields are invalid.');
  }
  return record as unknown as DiagnosisCapturePayload;
}

export function writeDiagnosisCaptureFromPool(input: {
  product: DiagnosisProduct;
  pool: Record<string, unknown>;
  deviceScope: string;
  keyring: CaptureKeyring;
  capturesDir: string;
  stagingRoot: string;
  capturedAt?: Date;
}): CaptureBundleSummary {
  const payload = createDiagnosisCapturePayload(input.product, input.pool, input.capturedAt);
  return promoteCapturePayload({
    payload,
    deviceScope: input.deviceScope,
    product: input.product,
    firmwareVersion: payload.firmwareVersion,
    capturesDir: input.capturesDir,
    stagingRoot: input.stagingRoot,
    keyring: input.keyring,
    capturedAt: input.capturedAt,
  });
}

export function readDiagnosisCapture(
  path: string,
  keyring: CaptureKeyring,
  expectedProduct?: DiagnosisProduct,
): DiagnosisCapturePayload {
  return validateDiagnosisCapturePayload(readCapturePayload(path, keyring), expectedProduct);
}

export function findLatestDiagnosisCapture(capturesDir: string, product: DiagnosisProduct): string | null {
  let candidates: Array<{ path: string; capturedAt: string }>;
  try {
    candidates = readdirSync(capturesDir)
      .filter((name) => name.endsWith('.enc'))
      .flatMap((name) => {
        const path = join(capturesDir, name);
        const bundle = readCaptureBundle(path);
        return bundle?.metadata.product === product ? [{ path, capturedAt: bundle.metadata.capturedAt }] : [];
      });
  } catch {
    return null;
  }
  return candidates.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))[0]?.path ?? null;
}

export function diagnosisCaptureFromEnv(product: DiagnosisProduct, env: NodeJS.ProcessEnv = process.env): DiagnosisCapturePayload {
  const capturesDir = env.SANGFOR_CAPTURE_ROOT ?? 'data/captures';
  const path = env.SANGFOR_CAPTURE_BUNDLE_PATH ?? findLatestDiagnosisCapture(capturesDir, product);
  if (!path) throw new Error(`CAPTURE_NOT_FOUND: no ${product} capture bundle is available.`);
  return readDiagnosisCapture(path, captureKeyringFromEnv(env), product);
}
