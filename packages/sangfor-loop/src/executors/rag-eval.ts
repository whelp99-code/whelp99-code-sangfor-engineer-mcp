import { allEvalCases, runPlannerEval } from '../../../sangfor-evals/src/index.js';
import { generateConfigPlan } from '../../../sangfor-planner/src/index.js';

// P3 — planner-eval regression after knowledge changes. For every product that
// has accumulated eval cases (seeds + feedback-derived), generate the canonical
// plan and run the eval suite against it. An empty/failing product is reported
// honestly — the ledger entry is the regression signal, never a pass claim.

export interface RagEvalProductResult {
  product: string;
  ok: boolean;
  caseCount: number;
  failed: string[];
}

export function runRagEvalExecutor(_input: Record<string, never>): { detail: string; results: RagEvalProductResult[] } {
  const cases = allEvalCases();
  const products = [...new Set(cases.map((c) => c.product))].sort();
  const results: RagEvalProductResult[] = products.map((product) => {
    const plan = generateConfigPlan({
      customerName: 'loop-regression',
      product,
      environment: {},
      requirements: [],
    });
    const evalResult = runPlannerEval(plan);
    return {
      product,
      ok: evalResult.ok,
      caseCount: evalResult.results.length,
      failed: evalResult.results.filter((r) => !r.pass).map((r) => r.id),
    };
  });
  return { detail: `${results.length} products, ${cases.length} cases evaluated`, results };
}
