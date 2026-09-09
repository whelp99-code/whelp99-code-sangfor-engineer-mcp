/** Evaluate the real planner surface, without calling templates verified Q&A. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { corpusEvalFixtureSchema } from '../packages/sangfor-rag/src/corpus-eval-contract.js';
const [indexPath, fixturePath] = process.argv.slice(2);
if (!indexPath || !fixturePath || process.argv.length !== 4) throw new Error('Usage: pnpm run rag:eval:plans <index.json> <fixture.json>');
const indexBytes = readFileSync(indexPath), fixtureBytes = readFileSync(fixturePath);
const fixture = corpusEvalFixtureSchema.parse(JSON.parse(fixtureBytes.toString('utf8')));
// The planner resolves this path at module initialization.
process.env.SANGFOR_RAG_INDEX_PATH = resolve(indexPath);
const { generateConfigPlanAsync, validateConfigPlan } = await import('../packages/sangfor-planner/src/index.js');
const rows = [];
for (const query of [...fixture.queries, ...fixture.noAnswerQueries]) {
  const start = performance.now();
  const plan = await generateConfigPlanAsync({ customerName: 'offline-evaluation', product: query.product, version: query.version, requirements: [query.query] });
  const references = [...plan.manualReferences, ...plan.wikiReferences];
  rows.push({ queryId: query.queryId, query: query.query, product: plan.product, version: plan.version,
    latencyMs: performance.now() - start, grounding: plan.grounding, validation: validateConfigPlan(plan),
    referenceIds: references.map((r) => r.id),
    steps: [...plan.precheck, ...plan.steps, ...plan.validationPlan, ...plan.rollbackPlan].map(({ title, description, references }) => ({ title, description, references })) });
}
if (!readFileSync(indexPath).equals(indexBytes) || !readFileSync(fixturePath).equals(fixtureBytes)) throw new Error('RAG_PLAN_EVAL_INPUT_CHANGED');
console.log(JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(),
  indexSha256: createHash('sha256').update(indexBytes).digest('hex'), fixtureSha256: createHash('sha256').update(fixtureBytes).digest('hex'),
  implementationSha256: createHash('sha256').update(readFileSync('packages/sangfor-planner/src/index.ts')).update(readFileSync('packages/sangfor-planner/src/grounding-assessment.ts')).digest('hex'),
  queryCount: rows.length, referenceIntegrityFailures: rows.filter((r) => r.grounding.status === 'INVALID_REFERENCES').length,
  answerReadyCount: rows.filter((r) => r.grounding.answerReady).length, answerAccuracy: null,
  limitation: 'This product surface generates configuration templates, not direct Q&A. Answer accuracy is not measured by reference existence or structural validation. Every template remains explicitly unverified.',
  rows }, null, 2));
