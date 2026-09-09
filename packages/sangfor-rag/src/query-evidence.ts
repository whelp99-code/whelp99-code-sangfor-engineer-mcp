import { tokenize } from './bm25.js';

// Request words and product scope are not evidence that the requested subject
// exists in a document. Keep this separate from ranking: these words may still
// help rank documents after subject support has been established.
const REQUEST_TERMS = new Set(('configure configured configuration configuring setting settings set setup '
  + 'guide manual document documentation explain explains show find list step steps method procedure '
  + 'sangfor athena hci asv scp ngfw ngaf iam iag ndr scc version release platform product '
  + '설정 구성 방법 절차 문서 가이드 알려주세요 무엇인가요 어떻게').split(' '));

export function querySubjectTerms(query: string): string[] {
  return [...new Set(tokenize(query))].filter((term) => !REQUEST_TERMS.has(term) && !/^\d+(?:\.\d+)*(?:r\d+)?$/.test(term));
}

/** Necessary lexical support, not a probability of answer correctness. */
export function subjectMatchCount(query: string, text: string): number {
  const terms = new Set(tokenize(text));
  return querySubjectTerms(query).filter((term) => terms.has(term)).length;
}
