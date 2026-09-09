import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { orderScoredHits } from '../../../packages/sangfor-rag/src/local-score-order.ts';
import { corpusEvalFixtureSchema } from '../../../packages/sangfor-rag/src/corpus-eval-contract.ts';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const policyPath = 'docs/references/revision-v5/score-floor-selection-policy-v2.json';
const policyBytes = readFileSync(policyPath), policy = JSON.parse(policyBytes);
const output = process.argv[2];
if (!output || existsSync(output)) throw new Error('Specify a new output path; never overwrite selection evidence');
const paths = {
  'revision-v1-qrels-v2': 'docs/references/revision-v5/full-calibration-original-with-order.json',
  'revision-v3-validation': 'docs/references/revision-v5/full-calibration-english.json',
  'revision-v5-client-korean-development': 'docs/references/revision-v5/full-calibration-client-korean.json',
  'revision-v5-client-holdout': 'docs/references/revision-v5/full-calibration-exposed-client.json',
};
const ensure = (condition, message) => { if (!condition) throw new Error(message); };
ensure(JSON.stringify(Object.keys(paths)) === JSON.stringify(Object.keys(policy.fixtures)), 'Policy fixture mismatch');
const sets = Object.entries(paths).map(([name,path]) => {
  const bytes = readFileSync(path), data = JSON.parse(bytes);
  const fixtureBytes = readFileSync(`data/evals/rag/${name}.json`), fixture = corpusEvalFixtureSchema.parse(JSON.parse(fixtureBytes));
  ensure(data.complete === true && data.fixture === name, `Incomplete/wrong fixture: ${name}`);
  ensure(hash(fixtureBytes) === data.fixtureSha256 && data.fixtureSha256 === policy.fixtures[name].sha256, `Fixture identity: ${name}`);
  for (const key of ['model','revision','configurationSha256','corpusSha256']) ensure(data[key] === policy[key], `${key} mismatch: ${name}`);
  ensure(fixture.k === 5 && fixture.noAnswerQueries.length > 0, 'Require positive and negative Hit@5 fixtures');
  const expected = [...fixture.queries, ...fixture.noAnswerQueries];
  ensure(data.rows.length === expected.length && new Set(data.rows.map(r => r.queryId)).size === expected.length, `Rows missing/duplicated: ${name}`);
  const rows = expected.map(q => {
    const r = data.rows.find(r => r.queryId === q.queryId);
    ensure(r && r.failure === null && r.diagnostics?.degraded === false && r.querySha256 === hash(q.query), `Failed/changed query: ${q.queryId}`);
    ensure(r.noAnswer === fixture.noAnswerQueries.some(n => n.queryId === q.queryId), `Changed classification: ${q.queryId}`);
    ensure(r.scored.length === r.candidateCount && r.scored.length <= 40, `Incomplete score set: ${q.queryId}`);
    ensure(Number.isFinite(r.seconds) && r.seconds >= 0, 'Missing latency');
    const scored = [...r.scored].sort((a,b) => a.retrievalRank-b.retrievalRank);
    ensure(new Set(scored.map(s => s.source)).size === scored.length, 'This selection requires distinct source candidates');
    for (const [i,s] of scored.entries()) {
      ensure(s.retrievalRank === i+1 && Number.isFinite(s.retrievalScore) && Number.isFinite(s.score), 'Invalid ranks/scores');
      ensure(typeof s.source === 'string' && /^[a-f0-9]{64}$/.test(s.scoringInputSha256), 'Missing input identity');
      ensure(s.relevant === (q.relevantSources ?? []).includes(s.source), `Changed relevance: ${q.queryId}`);
    }
    const candidates = scored.map(s => ({id:s.id, score:s.retrievalScore, source:s.source, relevant:s.relevant}));
    orderScoredHits(candidates, scored, 0, 'model'); // Complete unique candidate/score IDs must match.
    return {...r, candidates, forbidden: new Set(q.forbiddenSources ?? [])};
  });
  return { name, path, sha256:hash(bytes), sourceCommit:data.sourceCommit, rows, criteria:policy.fixtures[name] };
});
const scores = [...new Set(sets.flatMap(s => s.rows.flatMap(r => r.scored.map(h => h.score))))].sort((a,b) => a-b);
ensure(scores.length > 1, 'No score intervals to select');
const evaluate = (set,floor,order) => {
  const rows = set.rows.map(r => {
    const hits = orderScoredHits(r.candidates,r.scored,floor,order).slice(0,5);
    return {queryId:r.queryId,noAnswer:r.noAnswer,goldRank:hits.findIndex(h=>h.relevant)+1,returned:hits.length,forbiddenHits:hits.filter(h=>r.forbidden.has(h.source)).length};
  });
  const pos=rows.filter(r=>!r.noAnswer), neg=rows.filter(r=>r.noAnswer);
  return {fixture:set.name,hitRateAt5:pos.filter(r=>r.goldRank>0).length/pos.length,mrrAt5:pos.reduce((sum,r)=>sum+(r.goldRank?1/r.goldRank:0),0)/pos.length,noAnswerFalsePositiveRate:neg.filter(r=>r.returned>0).length/neg.length,forbiddenHits:rows.reduce((sum,r)=>sum+r.forbiddenHits,0),rows};
};
const eligible = [], bestPerOrder = {};
let evaluated = 0;
for (let i=1;i<scores.length;i++) {
  const lower=scores[i-1], upper=scores[i], floor=lower+(upper-lower)/2;
  ensure(Number.isFinite(floor) && floor>lower && floor<upper, 'Unrepresentable midpoint');
  for(const order of ['model','retrieval','rrf']) {
    const metrics=sets.map(s=>evaluate(s,floor,order)); evaluated++;
    const pass=metrics.every((m,j)=>m.hitRateAt5>=sets[j].criteria.hitRateAt5Min && m.noAnswerFalsePositiveRate<=sets[j].criteria.noAnswerFalsePositiveRateMax && m.forbiddenHits<=policy.forbiddenHitsMax);
    const row={floor,order,interval:[lower,upper],width:upper-lower,minHit:Math.min(...metrics.map(m=>m.hitRateAt5)),maxFalsePositive:Math.max(...metrics.map(m=>m.noAnswerFalsePositiveRate)),meanMrr:metrics.reduce((sum,m)=>sum+m.mrrAt5,0)/metrics.length,metrics:metrics.map(({rows,...m})=>m)};
    if(pass)eligible.push(row);
    const old=bestPerOrder[order];
    if(!old || row.minHit>old.minHit || (row.minHit===old.minHit && row.maxFalsePositive<old.maxFalsePositive))bestPerOrder[order]=row;
  }
}
eligible.sort((a,b)=>b.minHit-a.minHit || a.maxFalsePositive-b.maxFalsePositive || b.width-a.width || b.meanMrr-a.meanMrr || b.floor-a.floor);
const best=eligible[0]??null;
const result={status:best?'DEVELOPMENT_CANDIDATE_NOT_FINAL_ACCEPTANCE':'NO_ELIGIBLE_DEVELOPMENT_CANDIDATE',policyPath,policySha256:hash(policyBytes),selectorSha256:hash(readFileSync(new URL(import.meta.url))),orderImplementationSha256:hash(readFileSync('packages/sangfor-rag/src/local-score-order.ts')),calibrations:sets.map(({rows,criteria,...s})=>s),evaluated,eligibleCount:eligible.length,selected:best?{...best,metrics:sets.map(s=>evaluate(s,best.floor,best.order))}:null,bestPerOrder,limits:'Replay of complete development scores; no new inference. Forbidden hits refer to fixture-labelled sources only. Product/version/ACL and actual answer correctness require product-path validation. Same-author holdout-2 has not been evaluated.'};
writeFileSync(output,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({status:result.status,evaluated,eligibleCount:eligible.length,selected:best},null,2));
