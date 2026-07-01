/**
 * @sangfor/rca — symptom → ranked root-cause candidates + concrete check steps.
 *
 * Knowledge-grounded and conservative: candidates only come from matched cases
 * (product + keyword), each carries a manual/wiki source, and an unrelated symptom
 * returns an empty list rather than a fabricated guess.
 */

export type Likelihood = 'high' | 'medium' | 'low';

export interface RcaCandidate {
  cause: string;
  likelihood: Likelihood;
  checkSteps: string[];
  fix: string;
  source: string;
}

export interface RcaCase {
  id: string;
  product: string; // product code or 'ALL'
  keywords: string[];
  candidates: RcaCandidate[];
}

export interface RcaResult {
  symptom: string;
  product?: string;
  candidates: Array<RcaCandidate & { caseId: string; score: number }>;
}

const CASES: RcaCase[] = [
  {
    id: 'epp_agent_offline', product: 'EPP',
    keywords: ['agent', 'offline', 'endpoint', 'disconnect', 'not reporting', 'online'],
    candidates: [
      { cause: 'Endpoint network unreachable to EPP manager (firewall/route/DNS)', likelihood: 'high',
        checkSteps: ['에이전트 호스트에서 EPP 관리 IP로 통신 확인(telnet 443)', 'DNS/게이트웨이/프록시 확인', '방화벽 룰에서 관리 포트 허용 확인'],
        fix: '네트워크 경로/방화벽 룰 복구 후 에이전트 재연결 확인', source: 'Athena EPP 6.0.4 User Manual — Agent Deployment / Connectivity' },
      { cause: 'Agent service stopped or self-protection blocking', likelihood: 'medium',
        checkSteps: ['호스트에서 에이전트 서비스 상태 확인', '이벤트 로그에서 crash/quarantine 확인'],
        fix: '서비스 재시작 또는 에이전트 재배포', source: 'Athena EPP 6.0.4 User Manual — Agent Status' },
      { cause: 'Time/certificate mismatch between agent and manager', likelihood: 'low',
        checkSteps: ['호스트/관리자 NTP 동기 확인', '관리자 인증서 만료 확인'],
        fix: 'NTP 동기화·인증서 갱신', source: 'Athena EPP 6.0.4 User Manual — System / NTP' },
    ],
  },
  {
    id: 'iag_auth_fail', product: 'IAG',
    keywords: ['auth', 'authenticate', 'login', 'ldap', 'radius', 'ad', 'bind', 'sso', 'cannot log'],
    candidates: [
      { cause: 'LDAP/AD bind account invalid or insufficient permission', likelihood: 'high',
        checkSteps: ['User Management > Authentication Source에서 bind DN/비밀번호 확인', 'bind 계정 권한/잠금 확인', 'AD 도달성(389/636) 확인'],
        fix: 'bind 계정 자격/권한 복구, 인증소스 재테스트', source: 'Sangfor IAG v13.0.120 User Manual — Access Management / Authentication' },
      { cause: 'RADIUS shared secret mismatch', likelihood: 'medium',
        checkSteps: ['RADIUS 서버와 공유 시크릿 일치 확인', 'RADIUS 서버 도달성(1812) 확인'],
        fix: '공유 시크릿 재설정', source: 'Sangfor IAG v13.0.120 User Manual — RADIUS' },
      { cause: 'Time skew between IAG and identity source', likelihood: 'low',
        checkSteps: ['IAG/AD NTP 동기 확인'], fix: 'NTP 동기화', source: 'Sangfor IAG v13.0.120 User Manual — System / NTP' },
    ],
  },
  {
    id: 'hci_storage_heartbeat', product: 'HCI',
    keywords: ['storage', 'heartbeat', 'cluster', 'unstable', 'latency', 'mtu', 'san', 'node'],
    candidates: [
      { cause: 'Storage network MTU mismatch (jumbo frame not end-to-end)', likelihood: 'high',
        checkSteps: ['스토리지망 MTU를 노드/스위치 end-to-end로 확인', 'ping -M do -s 8972로 jumbo 통신 확인'],
        fix: 'MTU를 end-to-end 일관되게(권장 9000, 전 구간 지원 시) 설정', source: 'HCI 6.11 User Manual — Storage Network / MTU' },
      { cause: 'LACP bonding misconfiguration on storage VLAN', likelihood: 'medium',
        checkSteps: ['스위치 LACP/본딩 상태 확인', '스토리지 VLAN 격리 확인'], fix: 'LACP/VLAN 재구성', source: 'HCI 6.11 User Manual — Bonding' },
    ],
  },
  {
    id: 'cc_event_source_down', product: 'CC',
    keywords: ['event source', 'sensor', 'no events', 'syslog', 'ntp', 'correlation', 'collector'],
    candidates: [
      { cause: 'Event source/syslog forwarding misconfigured or unreachable', likelihood: 'high',
        checkSteps: ['Events > Event Sources 상태 확인', '소스 장비 syslog 포워딩 대상/포트 확인'],
        fix: '이벤트소스 연동 복구', source: 'Cyber Command 3.0 User Manual — Event Sources' },
      { cause: 'NTP time skew degrading correlation', likelihood: 'medium',
        checkSteps: ['CC/이벤트소스 NTP 동기 확인'], fix: 'NTP 동기화', source: 'Cyber Command 3.0 User Manual — NTP' },
    ],
  },
];

const likelihoodRank: Record<Likelihood, number> = { high: 3, medium: 2, low: 1 };

export function suggestRca(symptom: string, product?: string): RcaResult {
  if (typeof symptom !== 'string' || !symptom.trim()) return { symptom: String(symptom ?? ''), product, candidates: [] };
  const s = symptom.toLowerCase();
  const tokens = new Set(s.split(/[^a-z0-9]+/).filter(Boolean));
  const prod = product?.toString().toUpperCase();
  // Single-word keyword → whole-token match (no 'ad' inside 'download'); phrase → substring.
  const matches = (k: string) => (/\s/.test(k) ? s.includes(k.toLowerCase()) : tokens.has(k.toLowerCase()));
  const candidates: RcaResult['candidates'] = [];
  for (const c of CASES) {
    if (prod && c.product !== 'ALL' && c.product !== prod) continue;
    const score = [...new Set(c.keywords.filter(matches))].length;
    if (score === 0) continue;
    for (const cand of c.candidates) candidates.push({ ...cand, caseId: c.id, score });
  }
  candidates.sort((a, b) => b.score - a.score || likelihoodRank[b.likelihood] - likelihoodRank[a.likelihood]);
  return { symptom, product, candidates };
}
