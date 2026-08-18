/**
 * Cross-device spec evaluation over an intent edge (design 002, block D1).
 *
 * A cross-device spec is an ordinary IntendedSpec: the verdict engine stays
 * @sangfor/spec's evaluateSpec — no second verdict machinery, no LLM. This
 * module only ASSEMBLES one observed record from the two endpoints of an edge
 * and then applies the inferred-edge demotion.
 *
 * Demotion-only, mirroring the A1 freshness rule: when the edge itself was
 * inferred rather than declared, the relationship is a hypothesis, so a match
 * across it is not positive evidence — every would-be PASS becomes
 * INDETERMINATE ('inferred-edge'). FAIL is never masked: a mismatch across a
 * merely-suspected pair is still a real mismatch worth surfacing.
 */
import {
  evaluateSpec,
  type EvaluateOptions,
  type EvaluationResult,
  type EvaluationSummary,
  type IntendedSpec,
  type ItemResult,
} from '../../sangfor-spec/src/index.js';
import type { IntentEdge } from './graph.js';

export interface CrossDeviceKeySource {
  /** Which endpoint of the edge supplies the value. */
  device: 'from' | 'to';
  observedKey: string;
}

/** specObservedKey → where its value comes from on the edge. */
export type CrossDeviceKeyMap = Record<string, CrossDeviceKeySource>;

export interface AssembledCrossDeviceObserved {
  observed: Record<string, unknown>;
  edgeInferred: boolean;
}

/**
 * Collapse the two endpoints of an edge into a single observed record keyed by
 * the spec's observedKeys. A key whose source device or source observedKey is
 * absent is OMITTED — evaluateSpec then reports it as INDETERMINATE (no
 * observed value) instead of comparing against a fabricated value.
 */
export function assembleCrossDeviceObserved(
  edge: IntentEdge,
  observedByDevice: Record<string, Record<string, unknown>>,
  keyMap: CrossDeviceKeyMap,
): AssembledCrossDeviceObserved {
  const observed: Record<string, unknown> = {};
  for (const [specKey, source] of Object.entries(keyMap)) {
    const deviceId = source.device === 'from' ? edge.from : edge.to;
    const deviceObserved = observedByDevice[deviceId];
    if (!deviceObserved) continue;
    if (!Object.prototype.hasOwnProperty.call(deviceObserved, source.observedKey)) continue;
    observed[specKey] = deviceObserved[source.observedKey];
  }
  return { observed, edgeInferred: edge.derivedFrom === 'inferred' };
}

const INFERRED_EDGE_REASON =
  'inferred-edge: 관계가 관측 사실에서 추론됨 — 장비 간 일치를 PASS 근거로 삼을 수 없음 (inferred edge cannot prove cross-device intent)';

function summarize(items: readonly ItemResult[]): EvaluationSummary {
  return {
    pass: items.filter((i) => i.verdict === 'PASS').length,
    fail: items.filter((i) => i.verdict === 'FAIL').length,
    indeterminate: items.filter((i) => i.verdict === 'INDETERMINATE').length,
    misconfiguration: items.filter((i) => i.category === 'misconfiguration').length,
    missing: items.filter((i) => i.category === 'missing').length,
    contextDependent: items.filter((i) => i.category === 'context_dependent').length,
  };
}

/**
 * Evaluate a cross-device spec against an assembled record. Delegates the whole
 * verdict to evaluateSpec, then demotes PASS → INDETERMINATE when the edge was
 * inferred. `ok` keeps the engine's rule: positive evidence, no FAIL, nothing
 * undetermined — so a fully demoted result is never "ok".
 */
export function evaluateCrossDeviceSpec(
  spec: IntendedSpec,
  assembled: AssembledCrossDeviceObserved,
  options?: EvaluateOptions,
): EvaluationResult {
  const base = evaluateSpec(spec, assembled.observed, options);
  if (!assembled.edgeInferred) return base;

  const items: ItemResult[] = base.items.map((item) =>
    item.verdict === 'PASS'
      ? { ...item, verdict: 'INDETERMINATE', category: 'indeterminate', reason: INFERRED_EDGE_REASON }
      : item);
  const summary = summarize(items);
  return {
    ...base,
    items,
    summary,
    ok: summary.pass > 0 && summary.fail === 0 && summary.indeterminate === 0,
  };
}
