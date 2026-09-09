/** Public manuals describe procedures, not the current state of a customer's instance. */
export function requiresLiveRuntimeEvidence(query: string): boolean {
  const clauses = query.split(/\n|;|[?!]\s+|\band\s+(?=(?:how|what|which|who|show|list|tell)\b)/iu).map(part => part.trim()).filter(Boolean);
  return clauses.some(clause => {
    const instance = /\b(?:our|my|customer(?:'s)?|this\s+(?:device|cluster|appliance|deployment))\b|우리|저희|고객|내\s*(?:장비|클러스터|환경)/iu.test(clause);
    if (!instance) return false;
    // "How many are connected?" asks for a value; "how can I check?" asks for a procedure.
    const procedure = /\bhow\s+(?:to|do|does|can|could|should|would)\b|\bwhere\s+(?:can|do|should)\s+(?:i|we)\b|\b(?:steps|procedure|instructions)\s+(?:to|for)\b|방법|절차|어떻게\s*(?:확인|조회|설정|구성|찾|보)/iu.test(clause);
    const hypothetical = /\b(?:what|how|which|why)\b.*\bif\b|\b(?:suppose|assuming|hypothetically)\b|경우|한다면|했을\s*때|하면/iu.test(clause);
    if (procedure || hypothetical) return false;
    const current = /\b(?:current|currently|now|today|presently|at\s+this\s+moment|right\s+now)\b|현재|지금|오늘|실시간/iu.test(clause);
    const state = /\b(?:actual|real-world|connected|installed|configured|enabled|disabled|logged|remaining|available|running|assigned|active|stopped|private\s+keys?|passwords?|credentials?)\b|실제|설치|접속|로그인|남은|잔여|사용\s*중|켜져|꺼져|비밀번호|개인\s*키/iu.test(clause);
    const request = /\b(?:what|which|who|how\s+many|how\s+much|list|show|tell|identify|give|provide|report|check|find)\b|\b(?:is|are|does|do|has|have)\s+(?:our|my|this)\b|무엇|누구|몇|얼마|알려|나열|보여|확인|인가요|있나요/iu.test(clause);
    return request && (current || state);
  });
}
