import {
  evaluateSpec,
  loadSpec,
  renderAdvisoryReport,
  type EvaluationResult,
  type IntendedSpec,
  type ObservedFact,
} from '../packages/sangfor-spec/src/index.js';

const MAX_EVIDENCE_SOURCE_LENGTH = 256;
const TOP_LEVEL_KEYS = new Set(['schemaVersion', 'product', 'firmwareVersion', 'observed', 'observedAt', 'evidenceSource']);

export const IAG_LIVE_OBSERVED_ROUTES = Object.freeze({
  logRetentionDays: 'IAG WebUI > System > General > Report Center > Internal Report Center',
  webAuthEnabled: 'IAG WebUI > Functions > Access Management > Web Authentication',
  credentialWebAuthEnabled: 'IAG WebUI > Functions > Access Management > Web Authentication > Credential Authentication',
  dot1xEnabled: 'IAG WebUI > Functions > Access Management > 802.1X Authentication > Access Control',
  securityEventsCount: 'IAG WebUI > Dashboard > Security',
  haEnabled: 'IAG WebUI > System > Network > High Availability',
} as const);

type ObservedKey = keyof typeof IAG_LIVE_OBSERVED_ROUTES;
const OBSERVED_KEYS = new Set<ObservedKey>(Object.keys(IAG_LIVE_OBSERVED_ROUTES) as ObservedKey[]);

export interface IagLiveObservation {
  schemaVersion: 'iag-live-observation.v1';
  product: 'IAG';
  firmwareVersion: '13.0.120';
  observed: Partial<Record<ObservedKey, number | boolean>>;
  observedAt: string;
  evidenceSource: string;
}

export interface IagLiveDiagnosis {
  observation: IagLiveObservation;
  spec: IntendedSpec;
  result: EvaluationResult;
  report: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
}

function ownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, name: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`INPUT: unknown ${name} key "${key}".`);
  }
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`INPUT: ${key} must be a nonempty string.`);
  return value;
}

function canonicalIsoTimestamp(value: string): void {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new Error('INPUT: observedAt must be an exact ISO-8601 timestamp.');
  }
}

/** Strictly parse a sanitized, read-only IAG observation. No field is defaulted. */
export function parseIagLiveObservation(input: unknown): IagLiveObservation {
  if (!isPlainRecord(input)) throw new Error('INPUT: live observation must be a JSON object.');
  ownKeys(input, TOP_LEVEL_KEYS, 'top-level');

  if (input.schemaVersion !== 'iag-live-observation.v1') throw new Error('INPUT: schemaVersion must be iag-live-observation.v1.');
  if (input.product !== 'IAG') throw new Error('INPUT: product must be IAG.');
  if (input.firmwareVersion !== '13.0.120') throw new Error('INPUT: firmwareVersion must be 13.0.120.');
  const observedAt = requiredString(input, 'observedAt');
  canonicalIsoTimestamp(observedAt);
  const evidenceSource = requiredString(input, 'evidenceSource');
  if (evidenceSource !== evidenceSource.trim()
    || [...evidenceSource].length > MAX_EVIDENCE_SOURCE_LENGTH
    || !/^[\x20-\x7E]+$/u.test(evidenceSource)) {
    throw new Error(`INPUT: evidenceSource must be trimmed printable ASCII and at most ${MAX_EVIDENCE_SOURCE_LENGTH} characters.`);
  }

  if (!isPlainRecord(input.observed)) throw new Error('INPUT: observed must be an object.');
  ownKeys(input.observed, OBSERVED_KEYS, 'observed');
  const observed: IagLiveObservation['observed'] = {};
  for (const [key, value] of Object.entries(input.observed)) {
    if (key === 'logRetentionDays' || key === 'securityEventsCount') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`INPUT: observed.${key} must be a nonnegative safe integer.`);
      }
      observed[key] = value;
      continue;
    }
    if (typeof value !== 'boolean') throw new Error(`INPUT: observed.${key} must be a boolean.`);
    observed[key as Exclude<ObservedKey, 'logRetentionDays' | 'securityEventsCount'>] = value;
  }
  return { schemaVersion: 'iag-live-observation.v1', product: 'IAG', firmwareVersion: '13.0.120', observed, observedAt, evidenceSource };
}

/** Map only supplied sanitized values to evaluator facts with user-interface provenance. */
export function mapIagLiveObservationToFacts(observation: IagLiveObservation): Record<string, ObservedFact> {
  const facts: Record<string, ObservedFact> = {};
  for (const key of Object.keys(observation.observed) as ObservedKey[]) {
    facts[key] = {
      value: observation.observed[key],
      source: { collector: 'manual', collectedAt: observation.observedAt, endpoint: IAG_LIVE_OBSERVED_ROUTES[key] },
    };
  }
  return facts;
}

/** Add auditable provenance without claiming the observation is vendor-verified. */
export function appendIagLiveObservationProvenance(report: string, observation: IagLiveObservation): string {
  const normalizedReport = report.split('\n').map((line) => line.trimEnd()).join('\n').trimEnd();
  return `${normalizedReport}\n\n## Live observation provenance (sanitized, read-only)\n\n- schemaVersion: ${observation.schemaVersion}\n- observedAt: ${observation.observedAt}\n- evidenceSource: ${observation.evidenceSource}\n- collector: manual\n- device configuration was not changed by this diagnosis.\n`;
}

export function diagnoseIagLiveObservation(input: unknown): IagLiveDiagnosis {
  const observation = parseIagLiveObservation(input);
  const spec = loadSpec(observation.product, observation.firmwareVersion);
  if (!spec) throw new Error('PRECONDITION: merged IAG 13.0.120 spec is unavailable.');
  const result = evaluateSpec(spec, mapIagLiveObservationToFacts(observation));
  return { observation, spec, result, report: appendIagLiveObservationProvenance(renderAdvisoryReport(spec, result), observation) };
}
