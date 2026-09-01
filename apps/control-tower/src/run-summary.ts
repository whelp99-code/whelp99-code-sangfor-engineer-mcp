interface EvalLike { ok: boolean; summary: { pass: number; fail: number } }

function asEval(value: unknown): EvalLike | null {
  const e = value as { ok?: unknown; summary?: { pass?: unknown; fail?: unknown } } | null;
  return e && typeof e === 'object' && typeof e.ok === 'boolean'
    && typeof e.summary?.pass === 'number' && typeof e.summary?.fail === 'number'
    ? (e as EvalLike)
    : null;
}

// 스펙 §6.1: EvaluationResult(직접 | .evaluation | .evaluations[] 래핑)면 ok/pass/fail
// 요약, advisor 오류 결과({error})면 error 첫줄, 그 외 JSON 첫 150자. 최대 200자.
export function summarize(result: unknown): string {
  const cap = (s: string) => s.slice(0, 200);
  const fmt = (ok: boolean, pass: number, fail: number) => `ok=${ok} pass=${pass} fail=${fail}`;
  if (result && typeof result === 'object') {
    const r = result as { evaluation?: unknown; evaluations?: unknown[]; error?: unknown };
    const direct = asEval(result);
    if (direct) return fmt(direct.ok, direct.summary.pass, direct.summary.fail);
    const single = asEval(r.evaluation);
    if (single) return fmt(single.ok, single.summary.pass, single.summary.fail);
    if (Array.isArray(r.evaluations)) {
      const parts = r.evaluations.map(asEval).filter((p): p is EvalLike => p !== null);
      if (parts.length) {
        return fmt(
          parts.every((p) => p.ok),
          parts.reduce((n, p) => n + p.summary.pass, 0),
          parts.reduce((n, p) => n + p.summary.fail, 0),
        );
      }
    }
    if (typeof r.error === 'string') return cap(`error: ${r.error.slice(0, 150)}`);
  }
  try {
    return cap(JSON.stringify(result)?.slice(0, 150) ?? 'null');
  } catch {
    return cap(String(result).slice(0, 150));
  }
}
