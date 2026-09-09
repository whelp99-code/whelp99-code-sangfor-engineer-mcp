import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { clientAnswersSchema, evaluateAnswerEvidence } from '../packages/sangfor-rag/src/answer-evidence-eval.js';
const [contextPath, answersPath] = process.argv.slice(2);
if (!contextPath || !answersPath || process.argv.length !== 4) throw new Error('Usage: pnpm run rag:eval:answers <mcp-context.json> <client-answers.json>');
const contextBytes = readFileSync(contextPath), answerBytes = readFileSync(answersPath);
const answers = clientAnswersSchema.parse(JSON.parse(answerBytes.toString('utf8')));
const contextSha256 = createHash('sha256').update(contextBytes).digest('hex');
if (answers.contextSha256 !== contextSha256) throw new Error('RAG_ANSWER_EVAL_CONTEXT_CHANGED');
const report = evaluateAnswerEvidence(JSON.parse(contextBytes.toString('utf8')), answers);
console.log(JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), contextSha256,
  answersSha256: createHash('sha256').update(answerBytes).digest('hex'), ...report }, null, 2));
if (report.citationIntegrityFailures) process.exitCode = 1;
